/// <reference types="mocha" />
/* global describe, it */
'use strict';

const { expect } = require('chai');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// Load the actual adapter methods without constructing/starting an ioBroker adapter.
// Only MQTT is replaced, so no broker, BMW account or vehicle is accessed.
function fixture() {
  const callbacks = [];
  const client = Object.assign(new EventEmitter(), {
    connected: false,
    disconnecting: false,
    subscribe: (topics, callback) => {
      expect(topics).to.deep.equal({ 'test-account/+': { qos: 0 }, resubscribe: true });
      callbacks.push(callback);
    },
  });
  const sandbox = {
    module: { exports: {} },
    require: name => {
      if (name === '@iobroker/adapter-core') {
        return { Adapter: class {} };
      }
      return name === 'mqtt' ? { connect: () => client } : require(name);
    },
  };
  vm.runInNewContext(`${readFileSync(require.resolve('./main'), 'utf8')}\nmodule.exports = Bmw.prototype;`, sandbox);
  const adapter = Object.create(sandbox.module.exports);
  const states = [];
  adapter.session = { gcid: 'test-account', id_token: 'mock-token' };
  adapter.log = { info() {}, warn() {}, error() {}, debug() {} };
  adapter.setState = (id, value, ack) => states.push({ id, value, ack });
  adapter.refreshToken = async () => {};
  const connect = () => {
    client.connected = true;
    client.emit('connect');
  };
  const success = index => callbacks[index](null, [{ topic: 'test-account/+', qos: 0 }]);
  const status = () => states.filter(state => state.id === 'info.mqttConnected').at(-1)?.value;
  return { adapter, client, callbacks, connect, success, status, states };
}

describe('MQTT subscription status', () => {
  it('stays false until subscription acknowledgement, then becomes true', async () => {
    const f = fixture();
    await f.adapter.connectMQTT();
    expect(f.status()).to.equal(false);
    f.connect();
    expect(f.status()).to.equal(false);
    f.success(0);
    expect(f.status()).to.equal(true);
    expect(f.states.every(state => state.id === 'info.mqttConnected' && state.ack)).to.equal(true);
  });

  it('stays false when subscribe returns an error', async () => {
    const f = fixture();
    await f.adapter.connectMQTT();
    f.connect();
    f.callbacks[0](new Error('Subscribe error: Unspecified error'));
    expect(f.status()).to.equal(false);
  });

  for (const granted of [
    undefined,
    [],
    [{ topic: 'test-account/+', qos: 128 }],
    [{ topic: 'test-account/+', qos: undefined }],
    [{ topic: 'wrong/+', qos: 0 }],
  ]) {
    it(`does not treat unconfirmed or rejected grants as success: ${JSON.stringify(granted)}`, async () => {
      const f = fixture();
      await f.adapter.connectMQTT();
      f.connect();
      f.callbacks[0](null, granted);
      expect(f.status()).to.equal(false);
    });
  }

  for (const qos of [1, 2]) {
    it(`accepts successful QoS ${qos} grants`, async () => {
      const f = fixture();
      await f.adapter.connectMQTT();
      f.connect();
      f.callbacks[0](null, [{ topic: 'test-account/+', qos }]);
      expect(f.status()).to.equal(true);
    });
  }

  for (const event of ['close', 'offline', 'end', 'error', 'reconnect']) {
    it(`resets on ${event} and ignores stale success callbacks`, async () => {
      const f = fixture();
      await f.adapter.connectMQTT();
      f.connect();
      f.success(0);
      expect(f.status()).to.equal(true);
      f.connect();
      f.client.emit(event, new Error('test connection loss'));
      expect(f.status()).to.equal(false);
      f.success(1);
      expect(f.status()).to.equal(false);
    });
  }

  it('requires a fresh subscription on reconnect and ignores old acknowledgements', async () => {
    const f = fixture();
    await f.adapter.connectMQTT();
    f.connect();
    f.client.connected = false;
    f.client.emit('close');
    f.client.emit('reconnect');
    f.connect();
    f.success(0);
    expect(f.status()).to.equal(false);
    f.success(1);
    expect(f.status()).to.equal(true);
  });

  it('ignores success from a replaced client', async () => {
    const f = fixture();
    await f.adapter.connectMQTT();
    f.connect();
    f.adapter.mqtt = null;
    f.success(0);
    expect(f.status()).to.equal(false);
  });

  it('ignores success while ending the client (unload)', async () => {
    const f = fixture();
    await f.adapter.connectMQTT();
    f.connect();
    f.client.disconnecting = true;
    f.success(0);
    expect(f.status()).to.equal(false);
  });

  it('ignores success if the client is no longer connected before close fires', async () => {
    const f = fixture();
    await f.adapter.connectMQTT();
    f.connect();
    f.client.connected = false;
    f.success(0);
    expect(f.status()).to.equal(false);
  });
});

describe('Startup discovery recovery and periodic telematic updates (#354)', () => {
  /**
   * @param {{ interval?: number, requestHandler: (config: any, count: number) => Promise<any>, storedStates?: Record<string, any>, ignorelist?: string }} options
   */
  function createStartupFixture(options) {
    const { interval = 10, requestHandler, storedStates = {}, ignorelist = '' } = options;
    /** @type {Array<{ id: string, fn: () => Promise<void>, ms: number, cleared: boolean }>} */
    const intervals = [];
    /** @type {Array<{ id: string, fn: () => Promise<void>, ms: number, cleared: boolean }>} */
    const timeouts = [];
    /** @type {Array<any>} */
    const clearedIntervals = [];
    /** @type {Array<any>} */
    const clearedTimeouts = [];
    /** @type {{ info: string[], warn: string[], error: string[], debug: string[] }} */
    const logs = { info: [], warn: [], error: [], debug: [] };
    const states = new Map(Object.entries(storedStates));
    const objects = new Map();
    /** @type {string[]} */
    const cleanedVins = [];
    /** @type {any[]} */
    const requests = [];

    const mockClient = {
      connected: false,
      disconnecting: false,
      on() {},
      subscribe() {},
      end() {},
    };

    class MockAdapter {
      constructor() {
        this.config = {
          clientId: 'test-client-id',
          interval,
          ignorelist,
          abrpEnabled: false,
        };
        this.log = {
          /** @param {unknown} msg */
          info: msg => logs.info.push(String(msg)),
          /** @param {unknown} msg */
          warn: msg => logs.warn.push(String(msg)),
          /** @param {unknown} msg */
          error: msg => logs.error.push(String(msg)),
          /** @param {unknown} msg */
          debug: msg => logs.debug.push(String(msg)),
        };
      }
      on() {}
      subscribeStates() {}
      /**
       * @param {string} id
       * @param {unknown} val
       * @param {boolean} ack
       */
      setState(id, val, ack) {
        states.set(id, { val, ack });
      }
      /**
       * @param {string} id
       * @param {unknown} val
       * @param {boolean} ack
       */
      async setStateAsync(id, val, ack) {
        states.set(id, { val, ack });
      }
      /** @param {string} id */
      async getStateAsync(id) {
        return states.get(id) ?? null;
      }
      /**
       * @param {string} id
       * @param {unknown} obj
       */
      async extendObject(id, obj) {
        objects.set(id, obj);
      }
      /** @param {string} id */
      async getObjectAsync(id) {
        return objects.get(id) ?? null;
      }
      /** @param {string} id */
      async delObjectAsync(id) {
        objects.delete(id);
      }
      /**
       * @param {() => Promise<void>} fn
       * @param {number} ms
       */
      setInterval(fn, ms) {
        const handle = { id: `interval-${intervals.length + 1}`, fn, ms, cleared: false };
        intervals.push(handle);
        return handle;
      }
      /** @param {any} handle */
      clearInterval(handle) {
        if (handle) {
          handle.cleared = true;
          clearedIntervals.push(handle);
        }
      }
      /**
       * @param {() => Promise<void>} fn
       * @param {number} ms
       */
      setTimeout(fn, ms) {
        const handle = { id: `timeout-${timeouts.length + 1}`, fn, ms, cleared: false };
        timeouts.push(handle);
        return handle;
      }
      /** @param {any} handle */
      clearTimeout(handle) {
        if (handle) {
          handle.cleared = true;
          clearedTimeouts.push(handle);
        }
      }
    }

    const sandbox = {
      __dirname,
      module: { exports: /** @type {any} */ ({}) },
      require: /** @param {string} name */ name => {
        if (name === '@iobroker/adapter-core') {
          return { Adapter: MockAdapter };
        }
        if (name === 'mqtt') {
          return { connect: () => mockClient };
        }
        return require(name);
      },
    };

    vm.runInNewContext(`${readFileSync(require.resolve('./main'), 'utf8')}\nmodule.exports = Bmw;`, sandbox);
    const BmwClass = /** @type {new (opts: Record<string, unknown>) => any} */ (sandbox.module.exports);
    const adapter = new BmwClass({});

    adapter.sleep = async () => {};
    adapter.cleanObjects = /** @param {string} vin */ vin => cleanedVins.push(vin);
    adapter.connectMQTT = async () => true;
    adapter.refreshToken = async () => {};
    adapter.requestClient = /** @param {any} config */ async config => {
      requests.push(config);
      return await requestHandler(config, requests.length);
    };

    return {
      adapter,
      intervals,
      timeouts,
      clearedIntervals,
      clearedTimeouts,
      logs,
      states,
      cleanedVins,
      requests,
    };
  }

  /** @param {Record<string, any>} [extra] */
  function defaultStoredSession(extra = {}) {
    return {
      'cardataauth.session': {
        val: JSON.stringify({
          access_token: 'mock-access',
          refresh_token: 'mock-refresh',
          id_token: 'mock-id',
          gcid: 'test-gcid',
        }),
        ack: true,
      },
      'containerInfo.containerId': { val: 'cont-123', ack: true },
      ...extra,
    };
  }

  it('schedules periodic update interval and one-time 60s retry when startup discovery fails with EAI_AGAIN, and recovers on early retry', async () => {
    let online = false;
    const f = createStartupFixture({
      interval: 10,
      storedStates: defaultStoredSession(),
      requestHandler: async config => {
        if (!online) {
          throw Object.assign(new Error('getaddrinfo EAI_AGAIN api-cardata.bmwgroup.com'), { code: 'EAI_AGAIN' });
        }
        if (config.url.endsWith('/customers/vehicles/mappings')) {
          return { data: [{ vin: 'WBY11AA0000000001' }] };
        }
        if (config.url.endsWith('/customers/containers')) {
          return { data: { containers: [{ containerId: 'cont-123', state: 'ACTIVE', name: 'ioBroker', purpose: 'Full [v5]' }] } };
        }
        if (config.url.includes('/telematicData')) {
          return {
            data: {
              telematicData: {
                'vehicle.drivetrain.electricEngine.charging.level': { value: 82, timestamp: '2026-11-25T20:00:00Z' },
              },
            },
          };
        }
        throw new Error(`Unexpected URL: ${config.url}`);
      },
    });

    await f.adapter.onReady();

    expect(f.adapter.vinArray).to.deep.equal([]);
    expect(f.adapter.discoverySucceeded).to.equal(false);
    // Network errors without HTTP response must not consume quota
    expect(f.adapter.apiCalls).to.have.lengthOf(0);
    // Both refreshTokenInterval and updateInterval must be scheduled
    expect(f.intervals).to.have.lengthOf(2);
    expect(f.intervals[1].ms).to.equal(10 * 60 * 1000);
    // One-time 60s discovery retry must be scheduled
    expect(f.timeouts).to.have.lengthOf(1);
    expect(f.timeouts[0].ms).to.equal(60 * 1000);
    expect(f.logs.warn.some(m => m.includes('No vehicles discovered yet'))).to.equal(true);

    // Network comes back before the 60s early retry
    online = true;
    await f.timeouts[0].fn();

    expect(f.adapter.discoverySucceeded).to.equal(true);
    expect(f.adapter.vinArray).to.deep.equal(['WBY11AA0000000001']);
    // firstStart cleanup must not repeat on retry
    expect(f.cleanedVins).to.deep.equal([]);
    expect(f.states.get('WBY11AA0000000001.lastStreamViaAPIUpdate')?.val).to.be.a('string');
    // 1 mappings call + 1 telematicData call counted (not the failed EAI_AGAIN startup call)
    expect(f.adapter.apiCalls).to.have.lengthOf(2);
  });

  it('recovers discovery on a periodic interval tick after the 60s retry also fails', async () => {
    let mappingAttempts = 0;
    const f = createStartupFixture({
      interval: 15,
      storedStates: defaultStoredSession(),
      requestHandler: async config => {
        if (config.url.endsWith('/customers/vehicles/mappings')) {
          mappingAttempts++;
          if (mappingAttempts <= 2) {
            throw Object.assign(new Error('getaddrinfo EAI_AGAIN api-cardata.bmwgroup.com'), { code: 'EAI_AGAIN' });
          }
          return { data: [{ vin: 'WBY11AA0000000002' }] };
        }
        if (config.url.endsWith('/customers/containers')) {
          throw Object.assign(new Error('getaddrinfo EAI_AGAIN api-cardata.bmwgroup.com'), { code: 'EAI_AGAIN' });
        }
        if (config.url.includes('/telematicData')) {
          return {
            data: {
              telematicData: {
                'vehicle.drivetrain.electricEngine.charging.level': { value: 65, timestamp: '2026-11-25T20:10:00Z' },
              },
            },
          };
        }
        throw new Error(`Unexpected URL: ${config.url}`);
      },
    });

    await f.adapter.onReady();
    // 60s retry still offline
    await f.timeouts[0].fn();
    expect(f.adapter.vinArray).to.deep.equal([]);
    expect(f.adapter.discoverySucceeded).to.equal(false);
    expect(f.adapter.apiCalls).to.have.lengthOf(0);
    // No second retry timeout was scheduled
    expect(f.timeouts).to.have.lengthOf(1);

    // Next periodic interval tick recovers discovery and fetches telematic data
    await f.intervals[1].fn();
    expect(f.adapter.discoverySucceeded).to.equal(true);
    expect(f.adapter.vinArray).to.deep.equal(['WBY11AA0000000002']);
    expect(f.states.get('WBY11AA0000000002.lastStreamViaAPIUpdate')?.val).to.be.a('string');
  });

  it('does not poll mappings aggressively when discovery succeeded with zero vehicles', async () => {
    let mappingCalls = 0;
    const f = createStartupFixture({
      interval: 10,
      storedStates: defaultStoredSession(),
      requestHandler: async config => {
        if (config.url.endsWith('/customers/vehicles/mappings')) {
          mappingCalls++;
          return { data: [] };
        }
        if (config.url.endsWith('/customers/containers')) {
          return { data: { containers: [{ containerId: 'cont-123', state: 'ACTIVE', name: 'ioBroker', purpose: 'Full [v5]' }] } };
        }
        throw new Error(`Unexpected URL: ${config.url}`);
      },
    });

    await f.adapter.onReady();
    expect(f.adapter.discoverySucceeded).to.equal(true);
    expect(f.adapter.vinArray).to.deep.equal([]);
    expect(f.timeouts).to.have.lengthOf(0);
    expect(mappingCalls).to.equal(1);

    // Subsequent interval ticks must warn and skip without re-polling mappings
    await f.intervals[1].fn();
    await f.intervals[1].fn();
    expect(mappingCalls).to.equal(1);
    expect(f.logs.warn.some(m => m.includes('No BMW vehicles available'))).to.equal(true);
  });

  it('skips discovery retry during CU-429 cooldown and recovers once cooldown expires', async () => {
    let mappingCalls = 0;
    const f = createStartupFixture({
      interval: 10,
      storedStates: defaultStoredSession({
        'info.carDataQuotaBlockedUntil': { val: new Date(Date.now() + 30 * 60 * 1000).toISOString(), ack: true },
      }),
      requestHandler: async config => {
        if (config.url.endsWith('/customers/vehicles/mappings')) {
          mappingCalls++;
          return { data: [{ vin: 'WBY11AA0000000003' }] };
        }
        if (config.url.includes('/telematicData')) {
          return { data: { telematicData: { 'vehicle.cabin.door.status': { value: 'CLOSED', timestamp: '2026-11-25T20:15:00Z' } } } };
        }
        return { data: { containers: [] } };
      },
    });

    await f.adapter.onReady();
    expect(mappingCalls).to.equal(0);
    expect(f.adapter.discoverySucceeded).to.equal(false);

    // 60s retry and interval tick during cooldown must not call mappings API
    await f.timeouts[0].fn();
    await f.intervals[1].fn();
    expect(mappingCalls).to.equal(0);

    // Expire cooldown: next tick discovers the vehicle
    f.adapter.carDataQuotaBlockedUntil = Date.now() - 1000;
    await f.intervals[1].fn();
    expect(mappingCalls).to.equal(1);
    expect(f.adapter.discoverySucceeded).to.equal(true);
    expect(f.adapter.vinArray).to.deep.equal(['WBY11AA0000000003']);
  });

  it('deduplicates VINs across MQTT and getVehiclesv2 and counts HTTP errors but not network errors against quota', async () => {
    let mappingCalls = 0;
    let online = false;
    const f = createStartupFixture({
      interval: 10,
      storedStates: defaultStoredSession(),
      requestHandler: async config => {
        if (!online) {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }
        if (config.url.endsWith('/customers/vehicles/mappings')) {
          mappingCalls++;
          if (mappingCalls === 1) {
            throw Object.assign(new Error('Request failed with status code 500'), {
              response: { status: 500, data: { message: 'Internal error' } },
            });
          }
          return {
            data: [{ vin: 'WBY11AA0000000001' }, { vin: 'WBY11AA0000000001' }, { vin: 'WBY11AA0000000004' }],
          };
        }
        return { data: {} };
      },
    });

    await f.adapter.onReady();
    // ECONNREFUSED was not counted
    expect(f.adapter.apiCalls).to.have.lengthOf(0);

    // Simulate MQTT delivering one VIN before retry succeeds
    f.adapter.vinArray.push('WBY11AA0000000001');

    // 60s retry reaches server and gets HTTP 500 -> counted against quota
    online = true;
    await f.timeouts[0].fn();
    expect(f.adapter.apiCalls).to.have.lengthOf(1);
    expect(f.adapter.discoverySucceeded).to.equal(false);

    // Periodic tick gets mappings with duplicate VIN1 and new VIN4 -> counted + deduplicated
    await f.intervals[1].fn();
    expect(f.adapter.discoverySucceeded).to.equal(true);
    expect(f.adapter.vinArray).to.deep.equal(['WBY11AA0000000001', 'WBY11AA0000000004']);
  });

  it('clears discoveryRetryTimeout and updateInterval on unload', async () => {
    const f = createStartupFixture({
      interval: 10,
      storedStates: defaultStoredSession(),
      requestHandler: async () => {
        throw Object.assign(new Error('getaddrinfo EAI_AGAIN api-cardata.bmwgroup.com'), { code: 'EAI_AGAIN' });
      },
    });

    await f.adapter.onReady();
    expect(f.timeouts).to.have.lengthOf(1);
    expect(f.intervals).to.have.lengthOf(2);

    let unloaded = false;
    await f.adapter.onUnload(() => {
      unloaded = true;
    });

    expect(unloaded).to.equal(true);
    expect(f.timeouts[0].cleared).to.equal(true);
    expect(f.intervals[0].cleared).to.equal(true);
    expect(f.intervals[1].cleared).to.equal(true);
    expect(f.adapter.discoveryRetryTimeout).to.equal(null);
  });
});
