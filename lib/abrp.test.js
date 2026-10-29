/// <reference types="mocha" />
/* global describe, it */

'use strict';

const { expect } = require('chai');
const {
  ABRP_ENDPOINT,
  BMW_CHARGING_STATUS_KEY,
  BMW_DC_CHARGING_STATUS_KEY,
  BMW_DISTANCE_UNIT_KEYS,
  BMW_RANGE_KEYS,
  BMW_SOC_FALLBACK_KEY,
  BMW_SOC_PRIMARY_KEY,
  AbrpClient,
  AbrpTelemetryService,
  classifyAbrpError,
  describeCredential,
  getAbrpResponseDetail,
  mapBmwAuxTelemetry,
  mapBmwSocTelemetry,
  normalizeVehicleTokens,
  recoverDoubleEncryptedVehicleTokens,
} = require('./abrp');

class FakeClock {
  constructor(now) {
    this.nowMs = now;
    this.nextId = 1;
    this.tasks = [];
  }

  setTimeout(callback, delay) {
    const task = { id: this.nextId++, at: this.nowMs + delay, callback, cancelled: false };
    this.tasks.push(task);
    return task.id;
  }

  clearTimeout(id) {
    const task = this.tasks.find(candidate => candidate.id === id);
    if (task) {
      task.cancelled = true;
    }
  }

  async tick(milliseconds) {
    const target = this.nowMs + milliseconds;
    while (true) {
      this.tasks.sort((left, right) => left.at - right.at || left.id - right.id);
      const task = this.tasks.find(candidate => !candidate.cancelled && candidate.at <= target);
      if (!task) {
        break;
      }
      this.tasks = this.tasks.filter(candidate => candidate !== task);
      this.nowMs = task.at;
      task.callback();
      await this.flushPromises();
    }
    this.nowMs = target;
    await this.flushPromises();
  }

  async flushPromises() {
    for (let index = 0; index < 6; index++) {
      await Promise.resolve();
    }
  }
}

function bmwPayload(value, timestamp, key = BMW_SOC_PRIMARY_KEY) {
  return {
    [key]: {
      value,
      timestamp,
    },
  };
}

function bmwEntries(timestamp, values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, timestamp }]));
}

describe('ABRP telemetry', () => {
  describe('mapBmwSocTelemetry', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');

    it('maps numeric strings and preserves valid zero', () => {
      expect(mapBmwSocTelemetry(bmwPayload('0', '2026-10-28T11:59:30.900Z'), { now })).to.deep.equal({
        utc: 1793188770,
        soc: 0,
      });
    });

    it('prefers batteryManagement.header and falls back to stateOfCharge.displayed', () => {
      const timestamp = '2026-10-28T11:59:30.900Z';
      const bothValues = {
        ...bmwPayload(61, timestamp, BMW_SOC_PRIMARY_KEY),
        ...bmwPayload(62, timestamp, BMW_SOC_FALLBACK_KEY),
      };
      expect(mapBmwSocTelemetry(bothValues, { now })).to.deep.equal({ utc: 1793188770, soc: 61 });
      expect(mapBmwSocTelemetry(bmwPayload(62, timestamp, BMW_SOC_FALLBACK_KEY), { now })).to.deep.equal({
        utc: 1793188770,
        soc: 62,
      });
    });

    it('uses the fallback when the primary value is unusable', () => {
      const payload = {
        ...bmwPayload('invalid', '2026-10-28T11:59:30.900Z', BMW_SOC_PRIMARY_KEY),
        ...bmwPayload(63, '2026-10-28T11:59:31.900Z', BMW_SOC_FALLBACK_KEY),
      };
      expect(mapBmwSocTelemetry(payload, { now })).to.deep.equal({
        utc: 1793188771,
        soc: 63,
      });
    });

    it('rejects missing, invalid, out-of-range, stale, and future data', () => {
      expect(mapBmwSocTelemetry({}, { now })).to.equal(null);
      expect(mapBmwSocTelemetry(bmwPayload('', '2026-10-28T12:00:00Z'), { now })).to.equal(null);
      expect(mapBmwSocTelemetry(bmwPayload('invalid', '2026-10-28T12:00:00Z'), { now })).to.equal(null);
      expect(mapBmwSocTelemetry(bmwPayload(101, '2026-10-28T12:00:00Z'), { now })).to.equal(null);
      expect(mapBmwSocTelemetry(bmwPayload(50, '2026-10-28T11:44:59Z'), { now })).to.equal(null);
      expect(mapBmwSocTelemetry(bmwPayload(50, '2026-10-28T12:01:01Z'), { now })).to.equal(null);
    });
  });

  describe('mapBmwAuxTelemetry', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    const timestamp = '2026-10-28T11:59:30.000Z';

    it('maps BMW charging states to ABRP 1/0 flags', () => {
      const charging = mapBmwAuxTelemetry(
        bmwEntries(timestamp, {
          [BMW_CHARGING_STATUS_KEY]: 'CHARGINGACTIVE',
          [BMW_DC_CHARGING_STATUS_KEY]: 'CONNECTED',
        }),
        { now },
      );
      expect(charging.fields).to.deep.equal({
        is_charging: { value: 1, utc: 1793188770 },
        is_dcfc: { value: 1, utc: 1793188770 },
      });

      const notCharging = mapBmwAuxTelemetry(bmwEntries(timestamp, { [BMW_CHARGING_STATUS_KEY]: 'NOCHARGING' }), { now });
      expect(notCharging.fields.is_charging).to.deep.equal({ value: 0, utc: 1793188770 });
    });

    it('maps range in kilometres and converts a miles display', () => {
      const kilometres = mapBmwAuxTelemetry(
        bmwEntries(timestamp, {
          [BMW_DISTANCE_UNIT_KEYS[0]]: 'km',
          [BMW_RANGE_KEYS[0]]: 321,
        }),
        { now },
      );
      expect(kilometres.fields.est_battery_range).to.deep.equal({ value: 321, utc: 1793188770 });

      const miles = mapBmwAuxTelemetry(
        bmwEntries(timestamp, {
          [BMW_DISTANCE_UNIT_KEYS[1]]: 'MILES',
          [BMW_RANGE_KEYS[0]]: 100,
        }),
        { now },
      );
      expect(miles.fields.est_battery_range).to.deep.equal({ value: 160.9344, utc: 1793188770 });
    });

    it('omits unknown charging states and ambiguous display range units', () => {
      const mapped = mapBmwAuxTelemetry(
        bmwEntries(timestamp, {
          [BMW_CHARGING_STATUS_KEY]: 'UNKNOWN',
          [BMW_DC_CHARGING_STATUS_KEY]: 'INVALID',
          [BMW_RANGE_KEYS[0]]: 250,
        }),
        { now },
      );
      expect(mapped.fields).to.deep.equal({});
    });
  });

  it('normalizes enabled VIN/token mappings', () => {
    const tokens = normalizeVehicleTokens([
      { enabled: true, vin: ' wby123 ', token: ' first ' },
      { enabled: false, vin: 'WBY456', token: 'second' },
      { enabled: true, vin: '', token: 'missing-vin' },
    ]);
    expect([...tokens.entries()]).to.deep.equal([['WBY123', 'first']]);
  });

  it('recovers a legacy double-encrypted Generic token without changing valid plaintext', () => {
    const validToken = '00000000-0000-4000-8000-000000000001';
    const result = recoverDoubleEncryptedVehicleTokens(
      [
        { enabled: true, vin: 'WBY123', token: 'legacy-ciphertext' },
        { enabled: true, vin: 'WBY456', token: validToken },
        { enabled: true, vin: 'WBY789', token: 'non-uuid-token' },
      ],
      value => (value === 'legacy-ciphertext' ? validToken : 'not-a-uuid'),
    );

    expect(result.recovered).to.equal(1);
    expect(result.vehicles).to.deep.equal([
      { enabled: true, vin: 'WBY123', token: validToken },
      { enabled: true, vin: 'WBY456', token: validToken },
      { enabled: true, vin: 'WBY789', token: 'non-uuid-token' },
    ]);
  });

  it('builds an isolated ABRP request and validates the application status', async () => {
    const calls = [];
    const debugMessages = [];
    const httpClient = {
      async get(url, options) {
        calls.push({ url, options });
        return { data: { status: 'ok', missing: 'speed' } };
      },
    };
    const client = new AbrpClient({ apiKey: 'api-secret', httpClient, onRequestDebug: message => debugMessages.push(message) });
    await client.send('vehicle-secret', { utc: 123, soc: 45, is_charging: 1, is_dcfc: 0, est_battery_range: 234 });

    expect(calls).to.have.length(1);
    expect(calls[0].url).to.equal(ABRP_ENDPOINT);
    expect(calls[0].options.headers).to.deep.equal({
      Authorization: 'APIKEY api-secret',
    });
    expect(calls[0].options.params).to.deep.equal({
      token: 'vehicle-secret',
      tlm: '{"utc":123,"soc":45,"is_charging":1,"is_dcfc":0,"est_battery_range":234}',
    });
    expect(JSON.stringify(calls[0].options.params)).not.to.include('api-secret');
    expect(debugMessages).to.deep.equal([
      'ABRP outgoing request: GET https://api.iternio.com/1/tlm/send headers={"Authorization":"APIKEY api-…cret (length=10, sha256=014c243ff960e87a)"} params={"token":"vehi…cret (length=14, sha256=dd30dd91a52ed919)","tlm":{"utc":123,"soc":45,"is_charging":1,"is_dcfc":0,"est_battery_range":234}}',
    ]);
    expect(debugMessages[0]).not.to.include('api-secret');
    expect(debugMessages[0]).not.to.include('vehicle-secret');

    const rejectingClient = new AbrpClient({
      apiKey: 'api-secret',
      httpClient: { get: async () => ({ data: { status: 'error', code: 'INVALID_TOKEN', result: 'The vehicle token is invalid' } }) },
    });
    await expect(rejectingClient.send('vehicle-secret', { utc: 123, soc: 45 })).to.be.rejectedWith(
      'ABRP rejected telemetry: INVALID_TOKEN: The vehicle token is invalid',
    );
  });

  it('creates stable masked credential diagnostics', () => {
    expect(describeCredential('test-api-key-not-secret')).to.equal('test…cret (length=23, sha256=b4a674c32a096e60)');
  });

  it('classifies transient responses without exposing request details', () => {
    expect(classifyAbrpError({ response: { status: 429 }, config: { url: 'https://secret' } })).to.deep.equal({
      message: 'ABRP HTTP 429',
      retryable: true,
    });
    expect(classifyAbrpError({ response: { status: 403 } })).to.deep.equal({
      message: 'ABRP HTTP 403',
      retryable: false,
    });
    expect(
      classifyAbrpError({
        response: {
          status: 401,
          data: { error: { message: 'Invalid token abcdefghijklmnopqrstuvwxyz123456 at https://secret.example/path?api_key=secret' } },
        },
      }),
    ).to.deep.equal({
      message: 'ABRP HTTP 401: Invalid token [redacted] at [URL]',
      retryable: false,
    });
  });

  it('extracts only known ABRP response details', () => {
    expect(getAbrpResponseDetail({ status: 'error', error_code: 'FORBIDDEN', result: 'API key lacks post_data permission' })).to.equal(
      'FORBIDDEN: API key lacks post_data permission',
    );
    expect(getAbrpResponseDetail({ unknown: 'do not expose this body', token: 'vehicle-secret' })).to.equal('');
  });

  it('limits all VINs sharing a key to safely below two requests per second', async () => {
    const clock = new FakeClock(Date.parse('2026-10-28T12:00:00.000Z'));
    const starts = [];
    const client = {
      async send(token, telemetry) {
        starts.push({ at: clock.nowMs, token, telemetry });
        return { status: 'ok' };
      },
    };
    const service = new AbrpTelemetryService({
      enabled: true,
      apiKey: 'shared-key',
      vehicles: [
        { vin: 'VIN1', token: 'token1' },
        { vin: 'VIN2', token: 'token2' },
        { vin: 'VIN3', token: 'token3' },
      ],
      client,
      now: () => clock.nowMs,
      setTimeoutFn: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeoutFn: id => clock.clearTimeout(id),
    });
    const timestamp = new Date(clock.nowMs).toISOString();
    service.handleTelemetry('VIN1', bmwPayload(10, timestamp));
    service.handleTelemetry('VIN2', bmwPayload(20, timestamp));
    service.handleTelemetry('VIN3', bmwPayload(30, timestamp));

    await clock.tick(1200);
    expect(starts.map(call => call.at - Date.parse('2026-10-28T12:00:00.000Z'))).to.deep.equal([0, 550, 1100]);
    for (let index = 2; index < starts.length; index++) {
      expect(starts[index].at - starts[index - 2].at).to.be.at.least(1000);
    }
  });

  it('sends one stale last-known SoC as a current startup seed, then requires fresh data', async () => {
    const clock = new FakeClock(Date.parse('2026-10-28T12:00:00.000Z'));
    const starts = [];
    const service = new AbrpTelemetryService({
      enabled: true,
      apiKey: 'shared-key',
      vehicles: [{ vin: 'VIN1', token: 'token1' }],
      client: {
        async send(token, telemetry) {
          starts.push({ token, telemetry });
          return { status: 'ok' };
        },
      },
      now: () => clock.nowMs,
      setTimeoutFn: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeoutFn: id => clock.clearTimeout(id),
    });

    const staleTimestamp = '2026-10-27T12:00:00.000Z';
    expect(service.handleTelemetry('VIN1', bmwPayload(55, staleTimestamp)).queued).to.equal(true);
    await clock.tick(0);
    expect(starts).to.deep.equal([{ token: 'token1', telemetry: { utc: 1793188800, soc: 55 } }]);

    expect(service.handleTelemetry('VIN1', bmwPayload(56, staleTimestamp))).to.deep.equal({
      queued: false,
      reason: 'no-fresh-soc',
    });
    await clock.tick(600);
    expect(starts).to.have.length(1);

    expect(service.handleTelemetry('VIN1', bmwPayload(57, new Date(clock.nowMs).toISOString())).queued).to.equal(true);
    await clock.tick(0);
    expect(starts.map(call => call.telemetry.soc)).to.deep.equal([55, 57]);
  });

  it('merges partial charging and range MQTT updates with the latest fresh SoC', async () => {
    const clock = new FakeClock(Date.parse('2026-10-28T12:00:00.000Z'));
    const starts = [];
    const service = new AbrpTelemetryService({
      enabled: true,
      apiKey: 'shared-key',
      vehicles: [{ vin: 'VIN1', token: 'token1' }],
      client: {
        async send(token, telemetry) {
          starts.push({ token, telemetry });
          return { status: 'ok' };
        },
      },
      now: () => clock.nowMs,
      setTimeoutFn: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeoutFn: id => clock.clearTimeout(id),
      maxAgeMs: 1000,
    });

    service.handleTelemetry('VIN1', bmwPayload(48, new Date(clock.nowMs).toISOString()));
    await clock.tick(0);
    await clock.tick(10);
    service.handleTelemetry(
      'VIN1',
      bmwEntries(new Date(clock.nowMs).toISOString(), {
        [BMW_CHARGING_STATUS_KEY]: 'CHARGINGACTIVE',
        [BMW_DC_CHARGING_STATUS_KEY]: 'DISCONNECTED',
        [BMW_DISTANCE_UNIT_KEYS[0]]: 'km',
        [BMW_RANGE_KEYS[0]]: 275,
      }),
    );
    await clock.tick(550);

    expect(starts).to.have.length(2);
    expect(starts[1].telemetry).to.deep.equal({
      utc: 1793188800,
      soc: 48,
      is_charging: 1,
      is_dcfc: 0,
      est_battery_range: 275,
    });

    await clock.tick(451);
    expect(service.handleTelemetry('VIN1', bmwEntries(new Date(clock.nowMs).toISOString(), { [BMW_CHARGING_STATUS_KEY]: 'NOCHARGING' }))).to.deep.equal({
      queued: false,
      reason: 'no-fresh-soc',
    });
  });

  it('coalesces an MQTT burst to the newest unsent SoC for a VIN', async () => {
    const clock = new FakeClock(Date.parse('2026-10-28T12:00:00.000Z'));
    const starts = [];
    /** @type {(value: unknown) => void} */
    let releaseFirst = () => undefined;
    const firstRequest = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const client = {
      send(token, telemetry) {
        starts.push({ at: clock.nowMs, token, telemetry });
        return starts.length === 1 ? firstRequest : Promise.resolve({ status: 'ok' });
      },
    };
    const service = new AbrpTelemetryService({
      enabled: true,
      apiKey: 'shared-key',
      vehicles: [{ vin: 'VIN1', token: 'token1' }],
      client,
      now: () => clock.nowMs,
      setTimeoutFn: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeoutFn: id => clock.clearTimeout(id),
    });

    service.handleTelemetry('VIN1', bmwPayload(40, new Date(clock.nowMs).toISOString()));
    await clock.tick(0);
    await clock.tick(10);
    service.handleTelemetry('VIN1', bmwPayload(41, new Date(clock.nowMs).toISOString()));
    await clock.tick(10);
    service.handleTelemetry('VIN1', bmwPayload(42, new Date(clock.nowMs).toISOString()));
    releaseFirst({ status: 'ok' });
    await clock.flushPromises();
    await clock.tick(600);

    expect(starts).to.have.length(2);
    expect(starts.map(call => call.telemetry.soc)).to.deep.equal([40, 42]);
    expect(starts[1].at - starts[0].at).to.be.at.least(550);
  });

  it('routes retries through the same global limiter', async () => {
    const clock = new FakeClock(Date.parse('2026-10-28T12:00:00.000Z'));
    const starts = [];
    const client = {
      async send() {
        starts.push(clock.nowMs);
        if (starts.length === 1) {
          throw { response: { status: 500 } };
        }
        return { status: 'ok' };
      },
    };
    const service = new AbrpTelemetryService({
      enabled: true,
      apiKey: 'shared-key',
      vehicles: [{ vin: 'VIN1', token: 'token1' }],
      client,
      now: () => clock.nowMs,
      setTimeoutFn: (callback, delay) => clock.setTimeout(callback, delay),
      clearTimeoutFn: id => clock.clearTimeout(id),
    });

    service.handleTelemetry('VIN1', bmwPayload(50, new Date(clock.nowMs).toISOString()));
    await clock.tick(1200);
    expect(starts).to.deep.equal([Date.parse('2026-10-28T12:00:00.000Z'), Date.parse('2026-10-28T12:00:01.000Z')]);
  });
});
