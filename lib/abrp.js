'use strict';

const axios = require('axios');
const crypto = require('node:crypto');

const ABRP_ENDPOINT = 'https://api.iternio.com/1/tlm/send';
const BMW_SOC_PRIMARY_KEY = 'vehicle.drivetrain.batteryManagement.header';
const BMW_SOC_FALLBACK_KEY = 'vehicle.powertrain.electric.battery.stateOfCharge.displayed';
const BMW_SOC_KEYS = [BMW_SOC_PRIMARY_KEY, BMW_SOC_FALLBACK_KEY];
const BMW_CHARGING_STATUS_KEY = 'vehicle.drivetrain.electricEngine.charging.status';
const BMW_DC_CHARGING_STATUS_KEY = 'vehicle.body.chargingPort.dcStatus';
const BMW_RANGE_KEYS = ['vehicle.drivetrain.electricEngine.kombiRemainingElectricRange', 'vehicle.drivetrain.electricEngine.remainingElectricRange'];
const BMW_DISTANCE_UNIT_KEYS = ['vehicle.cabin.infotainment.displayUnit.distance', 'vehicle.cabin.infotainment.hmi.distanceUnit'];
const BMW_AUX_KEYS = [BMW_CHARGING_STATUS_KEY, BMW_DC_CHARGING_STATUS_KEY, ...BMW_RANGE_KEYS, ...BMW_DISTANCE_UNIT_KEYS];
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 60 * 1000;
const DEFAULT_REQUEST_INTERVAL_MS = 550;
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const DEFAULT_MAX_RETRIES = 2;

/** @typedef {{utc: number, soc: number, is_charging?: number, is_dcfc?: number, est_battery_range?: number}} AbrpTelemetry */
/** @typedef {{value: number, utc: number}} TimedAuxValue */
/** @typedef {{is_charging?: TimedAuxValue, is_dcfc?: TimedAuxValue, est_battery_range?: TimedAuxValue}} AuxTelemetryFields */

/** Error with a sanitized message and explicit retry classification. */
class AbrpRequestError extends Error {
  /**
   * @param {string} message - Sanitized error message.
   * @param {boolean} retryable - Whether the request may be retried.
   */
  constructor(message, retryable) {
    super(message);
    this.name = 'AbrpRequestError';
    this.retryable = retryable;
  }
}

/**
 * Describe a credential sufficiently for an exact comparison without logging it in full.
 *
 * @param {string} value - Credential value actually passed to the HTTP client.
 * @returns {string} Masked value, character count, and stable fingerprint.
 */
function describeCredential(value) {
  const preview = value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '[redacted]';
  const fingerprint = crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${preview} (length=${value.length}, sha256=${fingerprint})`;
}

/**
 * Build a safe but complete diagnostic representation of an outgoing ABRP request.
 *
 * @param {string} apiKey - API key actually passed to Axios.
 * @param {string} token - Generic vehicle token actually passed to Axios.
 * @param {AbrpTelemetry} telemetry - Telemetry actually passed to Axios.
 * @returns {string} Debug log message.
 */
function formatAbrpRequestDebug(apiKey, token, telemetry) {
  return `ABRP outgoing request: GET ${ABRP_ENDPOINT} headers=${JSON.stringify({ Authorization: `APIKEY ${describeCredential(apiKey)}` })} params=${JSON.stringify({ token: describeCredential(token), tlm: telemetry })}`;
}

/**
 * Normalize a VIN for configuration matching.
 *
 * @param {unknown} vin - VIN-like input.
 * @returns {string} Normalized VIN.
 */
function normalizeVin(vin) {
  return typeof vin === 'string' ? vin.trim().toUpperCase() : '';
}

/**
 * Convert configured vehicle rows to a VIN/token map.
 *
 * @param {unknown} rows - Adapter configuration rows.
 * @returns {Map<string, string>} Enabled vehicle tokens by VIN.
 */
function normalizeVehicleTokens(rows) {
  const tokens = new Map();
  if (!Array.isArray(rows)) {
    return tokens;
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.enabled === false) {
      continue;
    }
    const vin = normalizeVin(row.vin);
    const token = typeof row.token === 'string' ? row.token.trim() : '';
    if (vin && token) {
      tokens.set(vin, token);
    }
  }
  return tokens;
}

const UUID_CREDENTIAL_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Recover table tokens that older configuration code encrypted twice.
 *
 * The js-controller has already removed the outer `encryptedNative` layer when
 * the adapter receives its configuration. A leftover inner layer is recovered
 * only when decrypting it produces a UUID, so unrelated token formats remain
 * untouched.
 *
 * @param {unknown} rows - Adapter configuration rows.
 * @param {(value: string) => string} decrypt - ioBroker system-secret decryption.
 * @returns {{vehicles: unknown, recovered: number}} Recovered row copy and count.
 */
function recoverDoubleEncryptedVehicleTokens(rows, decrypt) {
  if (!Array.isArray(rows)) {
    return { vehicles: rows, recovered: 0 };
  }

  let recovered = 0;
  const vehicles = rows.map(row => {
    if (!row || typeof row !== 'object') {
      return row;
    }
    const tokenValue = Reflect.get(row, 'token');
    const token = typeof tokenValue === 'string' ? tokenValue.trim() : '';
    if (!token || UUID_CREDENTIAL_PATTERN.test(token)) {
      return row;
    }

    try {
      const candidate = decrypt(tokenValue).trim();
      if (UUID_CREDENTIAL_PATTERN.test(candidate)) {
        recovered++;
        return { ...row, token: candidate };
      }
    } catch {
      // Keep the original value; ABRP diagnostics will expose a safe fingerprint.
    }
    return row;
  });

  return { vehicles, recovered };
}

/**
 * Read one timestamped BMW entry if it is within the accepted time window.
 *
 * @param {unknown} data - BMW telematic payload.
 * @param {string} key - BMW technical identifier.
 * @param {number} now - Current epoch time in milliseconds.
 * @param {number} maxAgeMs - Maximum accepted measurement age.
 * @param {number} futureSkewMs - Maximum accepted future clock skew.
 * @returns {{value: unknown, utc: number} | null} Parsed entry.
 */
function readBmwEntry(data, key, now, maxAgeMs, futureSkewMs) {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const entry = data[key];
  if (!entry || typeof entry !== 'object' || entry.value === '' || entry.value === null || entry.value === undefined) {
    return null;
  }
  const measuredAt = Date.parse(entry.timestamp);
  if (!Number.isFinite(measuredAt) || now - measuredAt > maxAgeMs || measuredAt - now > futureSkewMs) {
    return null;
  }
  return { value: entry.value, utc: Math.floor(measuredAt / 1000) };
}

/**
 * Map a raw BMW telematic payload to the minimal ABRP telemetry object.
 *
 * @param {unknown} data - BMW telematic payload.
 * @param {object} [options] - Mapping options.
 * @param {number} [options.now] - Current epoch time in milliseconds.
 * @param {number} [options.maxAgeMs] - Maximum accepted measurement age.
 * @param {number} [options.futureSkewMs] - Maximum accepted clock skew into the future.
 * @returns {{utc: number, soc: number} | null} ABRP telemetry or null when unusable.
 */
function mapBmwSocTelemetry(data, options = {}) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const futureSkewMs = options.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS;

  for (const key of BMW_SOC_KEYS) {
    const entry = readBmwEntry(data, key, now, maxAgeMs, futureSkewMs);
    if (!entry) {
      continue;
    }

    const soc = Number(entry.value);
    if (!Number.isFinite(soc) || soc < 0 || soc > 100) {
      continue;
    }

    return {
      utc: entry.utc,
      soc,
    };
  }

  return null;
}

/**
 * Map fresh BMW charging state, DC state, and remaining range updates.
 *
 * @param {unknown} data - BMW telematic payload.
 * @param {object} [options] - Mapping options.
 * @param {number} [options.now] - Current epoch time in milliseconds.
 * @param {number} [options.maxAgeMs] - Maximum accepted measurement age.
 * @param {number} [options.futureSkewMs] - Maximum accepted future clock skew.
 * @param {string} [options.distanceUnit] - Previously cached BMW distance unit.
 * @returns {{distanceUnit?: string, fields: AuxTelemetryFields}} Auxiliary telemetry updates.
 */
function mapBmwAuxTelemetry(data, options = {}) {
  /** @type {AuxTelemetryFields} */
  const fields = {};
  if (!data || typeof data !== 'object') {
    return { fields };
  }

  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const futureSkewMs = options.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS;
  let distanceUnit = options.distanceUnit;

  for (const key of BMW_DISTANCE_UNIT_KEYS) {
    const entry = readBmwEntry(data, key, now, Number.POSITIVE_INFINITY, futureSkewMs);
    if (!entry || typeof entry.value !== 'string') {
      continue;
    }
    const unit = entry.value.trim().toUpperCase();
    if (unit === 'KM' || unit === 'KILOMETERS') {
      distanceUnit = 'km';
      break;
    }
    if (unit === 'MILES') {
      distanceUnit = 'miles';
      break;
    }
  }

  const charging = readBmwEntry(data, BMW_CHARGING_STATUS_KEY, now, maxAgeMs, futureSkewMs);
  if (charging && typeof charging.value === 'string') {
    const status = charging.value
      .trim()
      .toUpperCase()
      .replace(/[_\s-]/g, '');
    if (status === 'CHARGINGACTIVE' || status === 'CHARGING') {
      fields.is_charging = { value: 1, utc: charging.utc };
    } else if (['NOCHARGING', 'NOTCHARGING', 'INITIALIZATION', 'CHARGINGPAUSED', 'CHARGINGENDED', 'CHARGINGERROR'].includes(status)) {
      fields.is_charging = { value: 0, utc: charging.utc };
    }
  }

  const dcCharging = readBmwEntry(data, BMW_DC_CHARGING_STATUS_KEY, now, maxAgeMs, futureSkewMs);
  if (dcCharging && typeof dcCharging.value === 'string') {
    const status = dcCharging.value.trim().toUpperCase();
    if (status === 'CONNECTED') {
      fields.is_dcfc = { value: 1, utc: dcCharging.utc };
    } else if (status === 'DISCONNECTED') {
      fields.is_dcfc = { value: 0, utc: dcCharging.utc };
    }
  }

  for (const key of BMW_RANGE_KEYS) {
    const range = readBmwEntry(data, key, now, maxAgeMs, futureSkewMs);
    if (!range) {
      continue;
    }
    const value = Number(range.value);
    if (!Number.isFinite(value) || value < 0 || value > 4000) {
      continue;
    }
    const unit = key === BMW_RANGE_KEYS[1] ? 'km' : distanceUnit;
    if (unit === 'km' || unit === 'miles') {
      fields.est_battery_range = {
        value: unit === 'miles' ? value * 1.609344 : value,
        utc: range.utc,
      };
      break;
    }
  }

  return { distanceUnit, fields };
}

/**
 * Compare two telemetry points.
 *
 * @param {AbrpTelemetry | undefined} left - First point.
 * @param {AbrpTelemetry | undefined} right - Second point.
 * @returns {boolean} Whether both points are identical.
 */
function sameTelemetry(left, right) {
  if (!left || !right) {
    return false;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => left[key] === right[key]);
}

/**
 * Keep a useful ABRP error detail while removing values that could contain
 * credentials or request URLs. Only documented/common error fields are read;
 * the complete response body is deliberately never logged.
 *
 * @param {unknown} value - Candidate response detail.
 * @returns {string} Safe, compact detail or an empty string.
 */
function sanitizeAbrpResponseDetail(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z0-9_=-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Extract a human-readable error sent by ABRP without serializing arbitrary
 * response data. ABRP v1 responses have used fields such as result, error and
 * message over time, including nested error objects.
 *
 * @param {unknown} data - ABRP response body.
 * @returns {string} Sanitized ABRP response detail.
 */
function getAbrpResponseDetail(data) {
  const direct = sanitizeAbrpResponseDetail(data);
  if (direct) {
    return direct;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return '';
  }

  let code = '';
  for (const field of ['code', 'error_code', 'errorCode']) {
    code = sanitizeAbrpResponseDetail(Reflect.get(data, field));
    if (code) {
      break;
    }
  }

  for (const field of ['message', 'error_description', 'error', 'result', 'detail', 'description']) {
    const value = Reflect.get(data, field);
    const detail = sanitizeAbrpResponseDetail(value) || (value && typeof value === 'object' ? getAbrpResponseDetail(value) : '');
    if (detail) {
      return code && detail !== code ? `${code}: ${detail}` : detail;
    }
  }
  return code;
}

/**
 * Return a sanitized error classification without request URLs or credentials.
 *
 * @param {unknown} error - Axios or ABRP error.
 * @returns {{message: string, retryable: boolean}} Sanitized classification.
 */
function classifyAbrpError(error) {
  if (error instanceof AbrpRequestError) {
    return { message: error.message, retryable: error.retryable };
  }

  const response = error && typeof error === 'object' ? Reflect.get(error, 'response') : undefined;
  const statusValue = response && typeof response === 'object' ? Reflect.get(response, 'status') : undefined;
  const status = Number(statusValue);
  if (Number.isInteger(status) && status > 0) {
    const responseData = response && typeof response === 'object' ? Reflect.get(response, 'data') : undefined;
    const detail = getAbrpResponseDetail(responseData);
    return {
      message: `ABRP HTTP ${status}${detail ? `: ${detail}` : ''}`,
      retryable: status === 429 || status >= 500,
    };
  }

  const codeValue = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  const code = typeof codeValue === 'string' && /^[A-Z0-9_]+$/.test(codeValue) ? codeValue : 'NETWORK';
  return {
    message: `ABRP network error (${code})`,
    retryable: true,
  };
}

/** Minimal client for the Iternio v1 telemetry endpoint. */
class AbrpClient {
  /**
   * @param {object} options - Client options.
   * @param {string} options.apiKey - ABRP Telemetry API key.
   * @param {{get: (url: string, options: object) => Promise<{data: unknown}>}} [options.httpClient] - Injectable HTTP client.
   * @param {number} [options.timeoutMs] - Request timeout.
   * @param {(message: string) => void} [options.onRequestDebug] - Safe outgoing request diagnostic callback.
   */
  constructor(options) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.httpClient = options.httpClient ?? axios.create({ timeout: this.timeoutMs });
    this.onRequestDebug = options.onRequestDebug;
  }

  /**
   * Send one telemetry point.
   *
   * @param {string} token - Vehicle-specific Generic token.
   * @param {AbrpTelemetry} telemetry - ABRP telemetry.
   * @param {AbortSignal} [signal] - Optional shutdown cancellation signal.
   * @returns {Promise<unknown>} ABRP response body.
   */
  async send(token, telemetry, signal) {
    this.onRequestDebug?.(formatAbrpRequestDebug(this.apiKey, token, telemetry));
    const response = await this.httpClient.get(ABRP_ENDPOINT, {
      headers: {
        Authorization: `APIKEY ${this.apiKey}`,
      },
      params: {
        token,
        tlm: JSON.stringify(telemetry),
      },
      timeout: this.timeoutMs,
      signal,
    });

    if (!response.data || typeof response.data !== 'object' || Reflect.get(response.data, 'status') !== 'ok') {
      const detail = getAbrpResponseDetail(response.data);
      throw new AbrpRequestError(`ABRP rejected telemetry${detail ? `: ${detail}` : ''}`, false);
    }
    return response.data;
  }
}

/** Coordinates per-VIN telemetry through one API-key-wide rate limiter. */
class AbrpTelemetryService {
  /**
   * @param {object} options - Service options.
   * @param {boolean} options.enabled - Whether sending is enabled.
   * @param {string} options.apiKey - Shared ABRP API key.
   * @param {unknown} options.vehicles - Per-VIN token configuration.
   * @param {{send: (token: string, telemetry: AbrpTelemetry, signal?: AbortSignal) => Promise<unknown>}} [options.client] - Injectable API client.
   * @param {(vin: string, event: object) => (void | Promise<void>)} [options.onStatus] - Status callback.
   * @param {() => number} [options.now] - Clock in epoch milliseconds.
   * @param {(callback: () => void, delay: number) => any} [options.setTimeoutFn] - Timer function.
   * @param {(timer: any) => void} [options.clearTimeoutFn] - Timer cleanup function.
   * @param {number} [options.maxAgeMs] - Maximum telemetry age.
   * @param {number} [options.requestIntervalMs] - Minimum delay between request starts.
   * @param {number} [options.maxRetries] - Maximum transient retries.
   * @param {(message: string) => void} [options.onRequestDebug] - Safe outgoing request diagnostic callback.
   */
  constructor(options) {
    this.enabled = options.enabled === true;
    this.apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
    this.vehicleTokens = normalizeVehicleTokens(options.vehicles);
    this.vehicleOrder = [...this.vehicleTokens.keys()];
    this.client = options.client ?? new AbrpClient({ apiKey: this.apiKey, onRequestDebug: options.onRequestDebug });
    this.onStatus = options.onStatus;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    /** @type {Map<string, {telemetry: {utc: number, soc: number}, retryCount: number, availableAt: number}>} */
    this.pending = new Map();
    /** @type {Map<string, {utc: number, soc: number}>} */
    this.latestTelemetry = new Map();
    /** @type {Map<string, {utc: number, soc: number}>} */
    this.latestSoc = new Map();
    /** @type {Map<string, {utc: number, soc: number}>} */
    this.lastSent = new Map();
    /** @type {Map<string, {utc: number, soc: number}>} */
    this.inFlightTelemetry = new Map();
    /** @type {Map<string, AbortController>} */
    this.abortControllers = new Map();
    /** @type {Map<string, {distanceUnit?: string, fields: AuxTelemetryFields}>} */
    this.auxTelemetry = new Map();
    this.startupSeeded = new Set();
    this.lastRequestAt = Number.NEGATIVE_INFINITY;
    this.roundRobinIndex = 0;
    this.timer = null;
    this.stopped = false;
  }

  /**
   * Whether a VIN has an enabled token mapping.
   *
   * @param {string} vin - Vehicle VIN.
   * @returns {boolean} True when configured.
   */
  hasVehicle(vin) {
    return this.enabled && Boolean(this.apiKey) && this.vehicleTokens.has(normalizeVin(vin));
  }

  /**
   * Configured VINs.
   *
   * @returns {string[]} VIN list.
   */
  getConfiguredVins() {
    return [...this.vehicleOrder];
  }

  /**
   * Process an incoming raw BMW payload without blocking BMW state handling.
   *
   * @param {string} vin - Vehicle VIN.
   * @param {unknown} data - Raw BMW telematic data.
   * @returns {{queued: boolean, reason?: string}} Queue outcome.
   */
  handleTelemetry(vin, data) {
    const normalizedVin = normalizeVin(vin);
    if (!this.enabled || !this.apiKey || !this.vehicleTokens.has(normalizedVin) || this.stopped) {
      return { queued: false, reason: 'not-configured' };
    }

    const now = this.now();
    /** @type {AbrpTelemetry | null} */
    let telemetry = mapBmwSocTelemetry(data, { now, maxAgeMs: this.maxAgeMs });
    let startupSeed = false;
    if (!telemetry && !this.startupSeeded.has(normalizedVin)) {
      const startupTelemetry = mapBmwSocTelemetry(data, { now, maxAgeMs: Number.POSITIVE_INFINITY });
      if (startupTelemetry) {
        startupSeed = true;
        telemetry = {
          ...startupTelemetry,
          // A one-time last-known value initializes ABRP even while the vehicle sleeps.
          utc: Math.floor(now / 1000),
        };
      }
    }
    if (telemetry) {
      this.latestSoc.set(normalizedVin, { utc: telemetry.utc, soc: telemetry.soc });
    }

    const previousAux = this.auxTelemetry.get(normalizedVin) ?? { fields: {} };
    const auxUpdate = mapBmwAuxTelemetry(data, {
      now,
      maxAgeMs: startupSeed ? Number.POSITIVE_INFINITY : this.maxAgeMs,
      distanceUnit: previousAux.distanceUnit,
    });
    let auxChanged = auxUpdate.distanceUnit !== previousAux.distanceUnit;
    const auxFields = { ...previousAux.fields };
    for (const [key, entry] of Object.entries(auxUpdate.fields)) {
      const previous = auxFields[key];
      if (!previous || previous.value !== entry.value || previous.utc !== entry.utc) {
        auxChanged = true;
      }
      auxFields[key] = entry;
    }
    this.auxTelemetry.set(normalizedVin, { distanceUnit: auxUpdate.distanceUnit, fields: auxFields });

    if (!telemetry && auxChanged) {
      const latestSoc = this.latestSoc.get(normalizedVin);
      const latest = this.latestTelemetry.get(normalizedVin);
      if (latestSoc && now - latestSoc.utc * 1000 <= this.maxAgeMs) {
        const newestAuxUtc = Math.max(...Object.values(auxUpdate.fields).map(entry => entry.utc), latestSoc.utc);
        telemetry = { ...latest, ...latestSoc, utc: newestAuxUtc };
      }
    }
    if (!telemetry) {
      return { queued: false, reason: 'no-fresh-soc' };
    }

    for (const [key, entry] of Object.entries(auxFields)) {
      if ((startupSeed || now - entry.utc * 1000 <= this.maxAgeMs) && key !== 'is_dcfc') {
        telemetry[key] = entry.value;
      }
    }
    const dcEntry = auxFields.is_dcfc;
    if (telemetry.is_charging === 1 && dcEntry && (startupSeed || now - dcEntry.utc * 1000 <= this.maxAgeMs)) {
      telemetry.is_dcfc = dcEntry.value;
    } else {
      delete telemetry.is_dcfc;
    }
    this.startupSeeded.add(normalizedVin);
    this.latestTelemetry.set(normalizedVin, telemetry);
    return this._enqueue(normalizedVin, telemetry, false);
  }

  /**
   * Queue the latest still-fresh telemetry without fetching BMW data.
   *
   * @param {string} vin - Vehicle VIN.
   * @returns {{queued: boolean, reason?: string}} Queue outcome.
   */
  sendNow(vin) {
    const normalizedVin = normalizeVin(vin);
    if (!this.enabled || !this.apiKey || !this.vehicleTokens.has(normalizedVin) || this.stopped) {
      return { queued: false, reason: 'not-configured' };
    }

    const telemetry = this.latestTelemetry.get(normalizedVin);
    const latestSoc = this.latestSoc.get(normalizedVin);
    if (!telemetry || !latestSoc || this.now() - latestSoc.utc * 1000 > this.maxAgeMs) {
      return { queued: false, reason: 'no-fresh-soc' };
    }
    return this._enqueue(normalizedVin, telemetry, true);
  }

  /**
   * Stop scheduling, clear queued work, and abort in-flight HTTP requests.
   */
  stop() {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  /**
   * @param {string} vin - Normalized VIN.
   * @param {AbrpTelemetry} telemetry - Telemetry point.
   * @param {boolean} force - Whether to bypass successful-send deduplication.
   * @returns {{queued: boolean, reason?: string}} Queue outcome.
   */
  _enqueue(vin, telemetry, force) {
    const pending = this.pending.get(vin)?.telemetry;
    const inFlight = this.inFlightTelemetry.get(vin);
    if (sameTelemetry(pending, telemetry) || sameTelemetry(inFlight, telemetry) || (!force && sameTelemetry(this.lastSent.get(vin), telemetry))) {
      return { queued: false, reason: 'duplicate' };
    }

    this.pending.set(vin, { telemetry, retryCount: 0, availableAt: this.now() });
    this._emit(vin, { type: 'waiting', telemetry });
    this._schedule();
    return { queued: true };
  }

  /** Schedule the next globally rate-limited request. */
  _schedule() {
    if (this.stopped || this.timer !== null || this.pending.size === 0) {
      return;
    }

    const now = this.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const [vin, item] of this.pending) {
      if (!this.inFlightTelemetry.has(vin)) {
        earliest = Math.min(earliest, item.availableAt);
      }
    }
    if (!Number.isFinite(earliest)) {
      return;
    }

    const rateReadyAt = Number.isFinite(this.lastRequestAt) ? this.lastRequestAt + this.requestIntervalMs : now;
    const delay = Math.max(0, earliest - now, rateReadyAt - now);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this._dispatchNext();
    }, delay);
  }

  /** Start the next fair, eligible request. */
  _dispatchNext() {
    if (this.stopped) {
      return;
    }

    const now = this.now();
    if (Number.isFinite(this.lastRequestAt) && now - this.lastRequestAt < this.requestIntervalMs) {
      this._schedule();
      return;
    }

    const count = this.vehicleOrder.length;
    let selectedVin = '';
    for (let offset = 0; offset < count; offset++) {
      const index = (this.roundRobinIndex + offset) % count;
      const vin = this.vehicleOrder[index];
      const item = this.pending.get(vin);
      if (item && item.availableAt <= now && !this.inFlightTelemetry.has(vin)) {
        selectedVin = vin;
        this.roundRobinIndex = (index + 1) % count;
        break;
      }
    }

    if (!selectedVin) {
      this._schedule();
      return;
    }

    const item = this.pending.get(selectedVin);
    if (!item) {
      this._schedule();
      return;
    }
    this.pending.delete(selectedVin);

    if (now - item.telemetry.utc * 1000 > this.maxAgeMs) {
      this._emit(selectedVin, { type: 'error', message: 'ABRP telemetry became stale before sending' });
      this._schedule();
      return;
    }

    const token = this.vehicleTokens.get(selectedVin);
    if (!token) {
      this._schedule();
      return;
    }

    const controller = new AbortController();
    this.abortControllers.set(selectedVin, controller);
    this.inFlightTelemetry.set(selectedVin, item.telemetry);
    this.lastRequestAt = now;
    this._emit(selectedVin, { type: 'attempt', telemetry: item.telemetry });

    void this.client
      .send(token, item.telemetry, controller.signal)
      .then(() => {
        if (this.stopped) {
          return;
        }
        this.lastSent.set(selectedVin, item.telemetry);
        this._emit(selectedVin, { type: 'success', telemetry: item.telemetry });
      })
      .catch(error => {
        if (this.stopped || controller.signal.aborted) {
          return;
        }
        const classified = classifyAbrpError(error);
        const newerPending = this.pending.has(selectedVin);
        if (classified.retryable && item.retryCount < this.maxRetries && !newerPending) {
          const retryCount = item.retryCount + 1;
          const backoffMs = 1000 * 2 ** (retryCount - 1);
          this.pending.set(selectedVin, {
            telemetry: item.telemetry,
            retryCount,
            availableAt: this.now() + backoffMs,
          });
          this._emit(selectedVin, {
            type: 'waiting',
            telemetry: item.telemetry,
            message: `${classified.message}; retry ${retryCount}/${this.maxRetries}`,
          });
        } else if (!newerPending) {
          this._emit(selectedVin, { type: 'error', message: classified.message });
        }
      })
      .finally(() => {
        this.abortControllers.delete(selectedVin);
        this.inFlightTelemetry.delete(selectedVin);
        this._schedule();
      });

    this._schedule();
  }

  /**
   * Emit status without allowing state-writing failures to affect delivery.
   *
   * @param {string} vin - Vehicle VIN.
   * @param {object} event - Status event.
   */
  _emit(vin, event) {
    if (!this.onStatus || this.stopped) {
      return;
    }
    try {
      const result = this.onStatus(vin, event);
      if (result && typeof result.catch === 'function') {
        result.catch(() => undefined);
      }
    } catch {
      // Status reporting is deliberately isolated from telemetry delivery.
    }
  }
}

module.exports = {
  ABRP_ENDPOINT,
  BMW_AUX_KEYS,
  BMW_CHARGING_STATUS_KEY,
  BMW_DC_CHARGING_STATUS_KEY,
  BMW_DISTANCE_UNIT_KEYS,
  BMW_RANGE_KEYS,
  BMW_SOC_FALLBACK_KEY,
  BMW_SOC_KEYS,
  BMW_SOC_PRIMARY_KEY,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_REQUEST_INTERVAL_MS,
  AbrpClient,
  AbrpRequestError,
  AbrpTelemetryService,
  classifyAbrpError,
  describeCredential,
  formatAbrpRequestDebug,
  getAbrpResponseDetail,
  mapBmwAuxTelemetry,
  mapBmwSocTelemetry,
  normalizeVehicleTokens,
  normalizeVin,
  recoverDoubleEncryptedVehicleTokens,
};
