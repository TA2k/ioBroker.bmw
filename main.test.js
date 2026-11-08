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

  for (const granted of [undefined, [], [{ topic: 'test-account/+', qos: 128 }], [{ topic: 'test-account/+', qos: undefined }], [{ topic: 'wrong/+', qos: 0 }]]) {
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
