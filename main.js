'use strict';

// The adapter-core module gives you access to the core ioBroker functions you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios');

const crypto = require('node:crypto');
const qs = require('qs');
const Json2iob = require('json2iob');
const axiosRetry = require('axios-retry').default;
const fs = require('node:fs');
const path = require('node:path');

// BMW CarData API quota limit (calls per 24 hours)
const API_QUOTA_LIMIT = 50;

// Reduced set of telematic keys used when the "reducedContainer" option is enabled
// or as an automatic fallback when BMW refuses the full catalogue container with
// HTTP 403 (CU-403). Starts from the EV keys the evcc project uses successfully and
// adds elementary status data (doors, windows, locks, tyres, fuel, mileage, ignition,
// location, service) so combustion and general vehicle status are covered too.
// All keys verified against telematic.json.
const REDUCED_TELEMATIC_KEYS = [
  // Charging / high-voltage battery (EV)
  'vehicle.body.chargingPort.status',
  'vehicle.body.chargingPort.combinedStatus',
  'vehicle.cabin.hvac.preconditioning.status.comfortState',
  'vehicle.drivetrain.batteryManagement.header',
  'vehicle.drivetrain.electricEngine.charging.hvStatus',
  'vehicle.drivetrain.electricEngine.charging.status',
  'vehicle.drivetrain.electricEngine.charging.timeRemaining',
  'vehicle.drivetrain.electricEngine.kombiRemainingElectricRange',
  'vehicle.powertrain.electric.battery.stateOfCharge.displayed',
  'vehicle.powertrain.electric.battery.stateOfCharge.target',
  'vehicle.vehicle.preConditioning.activity',
  // Range / mileage / fuel (EV + combustion)
  'vehicle.drivetrain.lastRemainingRange',
  'vehicle.cabin.infotainment.navigation.remainingRange',
  'vehicle.vehicle.travelledDistance',
  'vehicle.drivetrain.fuelSystem.level',
  'vehicle.drivetrain.fuelSystem.remainingFuel',
  'vehicle.drivetrain.engine.isIgnitionOn',
  // Location
  'vehicle.cabin.infotainment.navigation.currentLocation.latitude',
  'vehicle.cabin.infotainment.navigation.currentLocation.longitude',
  'vehicle.cabin.infotainment.navigation.currentLocation.altitude',
  'vehicle.cabin.infotainment.navigation.currentLocation.heading',
  // Doors
  'vehicle.cabin.door.status',
  'vehicle.cabin.door.row1.driver.isOpen',
  'vehicle.cabin.door.row1.passenger.isOpen',
  'vehicle.cabin.door.row2.driver.isOpen',
  'vehicle.cabin.door.row2.passenger.isOpen',
  // Windows
  'vehicle.cabin.window.row1.driver.status',
  'vehicle.cabin.window.row1.passenger.status',
  'vehicle.cabin.window.row2.driver.status',
  'vehicle.cabin.window.row2.passenger.status',
  // Trunk / hood / lights
  'vehicle.body.trunk.isOpen',
  'vehicle.body.trunk.isLocked',
  'vehicle.body.hood.isOpen',
  'vehicle.body.lights.isRunningOn',
  // Tyre pressure + temperature (all four wheels)
  'vehicle.chassis.axle.row1.wheel.left.tire.pressure',
  'vehicle.chassis.axle.row1.wheel.right.tire.pressure',
  'vehicle.chassis.axle.row2.wheel.left.tire.pressure',
  'vehicle.chassis.axle.row2.wheel.right.tire.pressure',
  'vehicle.chassis.axle.row1.wheel.left.tire.temperature',
  'vehicle.chassis.axle.row1.wheel.right.tire.temperature',
  'vehicle.chassis.axle.row2.wheel.left.tire.temperature',
  'vehicle.chassis.axle.row2.wheel.right.tire.temperature',
  // Service / security
  'vehicle.status.serviceDistance.next',
  'vehicle.status.serviceTime.inspectionDateLegal',
  'vehicle.vehicle.antiTheftAlarmSystem.alarm.armStatus',
  'vehicle.channel.teleservice.status',
  'vehicle.vehicle.antiTheftAlarmSystem.alarm.isOn',
  // General driving / status
  'vehicle.vehicle.deepSleepModeActive',
  'vehicle.drivetrain.totalRemainingRange',
  // Detailed charging / HV battery (mirrors the bmw-cardata-ha HV_BATTERY set)
  'vehicle.drivetrain.electricEngine.charging.acAmpere',
  'vehicle.drivetrain.electricEngine.charging.acVoltage',
  'vehicle.drivetrain.electricEngine.charging.level',
  'vehicle.drivetrain.electricEngine.charging.method',
  'vehicle.drivetrain.electricEngine.charging.phaseNumber',
  'vehicle.drivetrain.electricEngine.charging.profile.mode',
  'vehicle.drivetrain.electricEngine.charging.timeToFullyCharged',
  'vehicle.drivetrain.electricEngine.charging.lastChargingReason',
  'vehicle.drivetrain.electricEngine.charging.lastChargingResult',
  'vehicle.drivetrain.electricEngine.charging.reasonChargingEnd',
  'vehicle.drivetrain.electricEngine.remainingElectricRange',
  'vehicle.drivetrain.batteryManagement.batterySizeMax',
  'vehicle.drivetrain.batteryManagement.maxEnergy',
  'vehicle.powertrain.electric.battery.charging.acLimit.selected',
  'vehicle.powertrain.electric.battery.charging.power',
  'vehicle.powertrain.electric.battery.stateOfHealth.displayed',
  'vehicle.powertrain.electric.battery.preconditioning.automaticMode.statusFeedback',
  'vehicle.powertrain.electric.battery.preconditioning.manualMode.statusFeedback',
  'vehicle.powertrain.tractionBattery.charging.port.anyPosition.flap.isOpen',
  'vehicle.powertrain.tractionBattery.charging.port.anyPosition.isPlugged',
  'vehicle.body.chargingPort.lockedStatus',
  'vehicle.body.chargingPort.plugEventId',
  'vehicle.trip.segment.end.drivetrain.batteryManagement.hvSoc',
  'vehicle.trip.segment.accumulated.drivetrain.electricEngine.recuperationTotal',
  'vehicle.vehicle.avgAuxPower',
  'vehicle.vehicleIdentification.basicVehicleData',
];

class Bmw extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options] - Optional adapter configuration options.
   */
  constructor(options) {
    super({
      ...options,
      name: 'bmw',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));

    // BMW CarData API endpoints
    this.carDataApiBase = 'https://api-cardata.bmwgroup.com';
    this.authApiBase = 'https://customer.bmwgroup.com/gcdm/oauth';

    // Core properties
    this.updateInterval;
    this.refreshTokenInterval;
    this.vinArray = [];
    this.session = {};
    this.json2iob = new Json2iob(this);

    // MQTT client
    this.mqtt = null;

    // API quota tracking
    this.apiCalls = [];

    // Container ID for telematic data
    this.containerId = null;

    // Flag to track initial login (not adapter restart)
    this.initialLogin = false;

    // Position tracking for reverse geocoding debounce
    this.lastPosition = {}; // { vin: { lat, lon, timestamp } }
    this.reverseGeocodeTimers = {}; // { vin: timer }

    // Initialize descriptions and states from telematic.json
    this.description = {};
    this.states = {};

    this.requestClient = axios.create({
      withCredentials: true,
    });
    axiosRetry(this.requestClient, {
      retries: 0,
      retryDelay: () => {
        return 5000;
      },
    });
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    this.setState('info.connection', false, true);
    this.setState('info.mqttConnected', false, true);

    // Validate configuration
    if (!this.config.clientId) {
      this.log.error(`BMW CarData Client ID not configured! Please set up in adapter settings.`);
      this.log.info(`Visit BMW ConnectedDrive portal, go to CarData section, and generate a client ID`);
      return;
    }

    if (this.config.interval < 10 && this.config.interval !== 0) {
      this.log.info('Setting minimum interval to 10 minutes due to API quota limits');
      this.config.interval = 10;
    }

    this.subscribeStates('*');

    this.initializeTelematicData();

    // Initialize API quota tracking - restore from saved history
    const apiCallsHistoryState = await this.getStateAsync('info.apiCallsHistory');
    if (apiCallsHistoryState?.val && typeof apiCallsHistoryState.val === 'string') {
      try {
        this.apiCalls = JSON.parse(apiCallsHistoryState.val);
        this.log.debug(`Restored ${this.apiCalls.length} API call timestamps from history`);
      } catch (error) {
        this.log.error(`Failed to parse API calls history: ${error.message}`);
        this.log.warn('Failed to parse API calls history, starting fresh');
        this.apiCalls = [];
      }
    } else {
      this.apiCalls = [];
    }

    // Calculate and set quota states based on restored history
    this.updateQuotaStates();

    // Try to restore stored session
    const sessionState = await this.getStateAsync('cardataauth.session');
    if (sessionState?.val && typeof sessionState.val === 'string') {
      try {
        this.session = JSON.parse(sessionState.val);
        this.log.info('Found stored BMW CarData session');

        // Try to refresh tokens
        await this.refreshToken();
      } catch (error) {
        this.log.warn(`Failed to parse stored session, starting new login ${error.message}`);
        await this.login();
      }
    } else {
      this.log.info('No stored session found, starting BMW CarData authorization');
      await this.login();
    }

    // Proceed if we have valid tokens
    if (this.session.access_token && this.session.gcid) {
      this.log.info('Starting BMW CarData vehicle discovery...');

      // Get vehicles first to populate vinArray
      await this.getVehiclesv2(true);

      // Setup telematic container after we have vehicles
      await this.setupTelematicContainer();

      // Connect MQTT after successful auth
      await this.connectMQTT();
      // Start periodic token refresh (every 45 minutes)
      this.refreshTokenInterval = this.setInterval(
        async () => {
          await this.refreshToken();
        },
        56 * 60 * 1000,
      );

      // Start periodic telematic data updates (respecting quota limits)
      if (this.vinArray.length > 0 && this.config.interval > 0) {
        this.log.info(`Setting up periodic telematic data updates every ${this.config.interval} minutes for ${this.vinArray.length} vehicle(s)`);
        this.updateInterval = this.setInterval(
          async () => {
            // Update quota states (expired calls removed automatically)
            this.updateQuotaStates();

            // Periodic telematic data refresh - MQTT provides real-time updates
            if (!this.containerId) {
              this.log.warn(`No container ID available for periodic telematic data fetch, setting up container...`);
              const setupSuccess = await this.setupTelematicContainer();
              if (!setupSuccess) {
                this.log.error(`Failed to setup telematic container for periodic updates`);
                return;
              }
            }

            for (const vin of this.vinArray) {
              this.log.debug(`Periodic telematic data refresh for ${vin}`);
              try {
                const telematicData = await this.getTelematicContainer(vin, this.containerId);
                if (telematicData && telematicData.telematicData) {
                  // Store telematic data directly in stream folder
                  await this.json2iob.parse(`${vin}.stream`, telematicData.telematicData, {
                    descriptions: this.description,
                    states: this.states,
                    autoCast: true,

                    useCompletePathForDescriptionsAndStates: true,
                    forceIndex: true,
                  });

                  // Update lastAPIUpdate timestamp
                  await this.setState(`${vin}.lastStreamViaAPIUpdate`, new Date().toISOString(), true);

                  this.log.debug(`✓ Periodic telematic data update for ${vin}: ${Object.keys(telematicData.telematicData).length} data points`);
                } else {
                  this.log.warn(`No telematic data retrieved for ${vin} during periodic update`);
                }
              } catch (error) {
                this.log.error(`Periodic telematic data fetch failed for ${vin}: ${error.message}`);
              }
            }
          },
          this.config.interval * 60 * 1000,
        );
      } else if (this.config.interval === 0) {
        this.log.info('Periodic telematic data updates disabled (interval = 0)');
      }

      this.log.info(`BMW CarData adapter startup complete`);
      this.log.info(`MQTT streaming: enabled`);
      this.log.info(
        `API quota: ${API_QUOTA_LIMIT - this.apiCalls.length}/${API_QUOTA_LIMIT} calls remaining for API calls. Updates via MQTT do not count against quota.`,
      );
    } else {
      this.log.error('BMW CarData authentication failed');
    }
  }

  async login() {
    if (!this.config.clientId) {
      this.log.error(`BMW CarData Client ID not configured! Please set up in adapter settings.`);
      return false;
    }

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    try {
      // Step 1: Get device code
      this.log.debug(`Starting BMW CarData device authorization flow`);
      this.log.debug(`Auth API Base: ${this.authApiBase}`);
      this.log.debug(`Client ID: ${this.config.clientId}`);
      this.log.debug(`Code Challenge: ${codeChallenge}`);

      // Request the CarData scopes explicitly. Omitting 'scope' does NOT grant the full
      // registered set as the swagger implies - BMW then returns a token without
      // 'cardata:api:read', so every CarData call fails with CU-103 ("The token-scope is
      // not CarData"). These four scopes match the BMW CarData portal registration and
      // the evcc reference implementation. The granted scope is logged after the token
      // exchange for diagnostics.
      const requestData = {
        client_id: this.config.clientId,
        response_type: 'device_code',
        scope: 'authenticate_user openid cardata:streaming:read cardata:api:read',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      };
      this.log.debug(`Device code request data: ${JSON.stringify(requestData)}`);

      const deviceResponse = await this.requestClient({
        method: 'post',
        url: `${this.authApiBase}/device/code`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        data: requestData,
      })
        .then(res => {
          this.log.debug(`Device code response: ${JSON.stringify(res.data)}`);
          return res;
        })
        .catch(error => {
          this.log.error(`Device code request failed: ${error.message}`);
          this.log.debug(`Error stack: ${error.stack}`);
          if (error.response) {
            this.log.error(`Response status: ${error.response.status}`);
            this.log.error(`Response headers: ${JSON.stringify(error.response.headers)}`);
            this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);

            // Special handling for 400 Bad Request - likely client configuration issue
            if (error.response.status === 400) {
              this.log.error(`===================================================`);
              this.log.error(`BMW CLIENT ID CONFIGURATION ERROR (400 Bad Request)`);
              this.log.error(`===================================================`);
              this.log.error(`This error usually means:`);
              this.log.error(`1. CarData API access is not activated for your Client ID`);
              this.log.error(`2. CarData Streaming is not enabled for your Client ID`);
              this.log.error(`3. Your Client ID is invalid or has been revoked`);
              this.log.error('');
              this.log.error(`To fix this issue:`);
              this.log.error(`1. Visit BMW ConnectedDrive portal: https://www.bmw.de/de-de/mybmw/vehicle-overview`);
              this.log.error(`2. Go to CarData section`);
              this.log.error(`3. Check if CarData API and CarData Streaming are both activated. Sometimes it needs 30s to save the selection!`);
              this.log.error(`4. If not activated, enable both services`);
              this.log.error(`5. If already activated, delete and recreate your Client ID`);
              this.log.error(`6. Update the adapter configuration with the new Client ID`);
              this.log.error(`===================================================`);
            }
          }
          if (error.request) {
            this.log.error(
              `Request details: ${JSON.stringify({
                method: error.request.method,
                url: error.request.url,
                headers: error.request._headers,
              })}`,
            );
          }
          return false; // Return false instead of throwing
        });

      if (!deviceResponse || typeof deviceResponse !== 'object') {
        return false; // Exit if device code request failed
      }

      const { user_code, device_code, verification_uri_complete, verification_uri, expires_in, interval } = deviceResponse.data;
      // BMW only returns verification_uri (per Device Code Flow swagger v1.6); verification_uri_complete
      // is optional (RFC 8628) and not sent. Fall back so all cases are covered.
      const verificationUrl = verification_uri_complete || verification_uri;
      this.log.debug(`Device code: ${device_code}, User code: ${user_code}, Expires in: ${expires_in}s, Interval: ${interval}s`);

      // Show user instructions
      this.log.info('='.repeat(80));
      this.log.info(`BMW CARDATA AUTHORIZATION REQUIRED`);
      this.log.info('='.repeat(80));
      this.log.info(`1. Visit: ${verificationUrl}`);
      this.log.info(`2. Or visit: ${verification_uri} and enter code: ${user_code}`);
      this.log.info(`3. Login with your BMW account and authorize`);
      this.log.info(`4. Code expires in ${Math.floor(expires_in / 60)} minutes`);
      this.log.info(`The adapter will automatically continue after authorization`);
      this.log.info('='.repeat(80));

      // Step 2: Poll for tokens
      const startTime = Date.now();
      this.log.debug(`Starting token polling, will timeout in ${expires_in}s`);
      while (Date.now() - startTime < expires_in * 1000) {
        this.log.debug(`Waiting ${interval}s before next token poll...`);
        await this.sleep(interval * 1000);

        try {
          const tokenRequestData = {
            client_id: this.config.clientId,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: device_code,
            code_verifier: codeVerifier,
          };
          this.log.debug(`Token request data: ${JSON.stringify(tokenRequestData)}`);

          const tokenResponse = await this.requestClient({
            method: 'post',
            url: `${this.authApiBase}/token`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: qs.stringify(tokenRequestData),
          });

          // Success! Store tokens in existing session structure
          this.session = tokenResponse.data;

          // Dump the same token fields evcc extracts (gcid, id_token) plus the standard
          // OAuth fields, so a user can diff this log line against an evcc setup. evcc logs
          // gcid + id_token + expiry in its MQTT debug line; here we log all of them once at
          // token exchange. Tokens are shortened to avoid leaking full credentials.
          const shorten = v => (typeof v === 'string' && v.length > 12 ? `${v.slice(0, 8)}...${v.slice(-4)} (len ${v.length})` : v || 'MISSING');
          this.log.debug(
            `Token (evcc-comparable): scope=${this.session.scope || 'MISSING'} token_type=${this.session.token_type || 'MISSING'} expires_in=${this.session.expires_in || 'MISSING'} gcid=${this.session.gcid || 'MISSING'} id_token=${shorten(this.session.id_token)} access_token=${shorten(this.session.access_token)} refresh_token=${shorten(this.session.refresh_token)}`,
          );

          // Log the effective granted scope. We request cardata:api:read explicitly; if
          // BMW still does not grant it, the Client ID is not subscribed to the CarData API.
          this.log.debug(`Token scope granted: ${this.session.scope || 'MISSING'} (token_type: ${this.session.token_type})`);
          if (this.session.scope && !this.session.scope.includes('cardata:api:read')) {
            this.log.warn(
              `Token is missing the 'cardata:api:read' scope - CarData API calls (e.g. creating the telematic container) will fail. Subscribe to CarData API in the BMW portal, then delete the Client ID and re-authorize.`,
            );
          }
          // MQTT streaming uses the id_token as its password; it only exists when the
          // 'openid' scope is granted. Warn if it is missing so a broken stream is diagnosable.
          if (!this.session.id_token) {
            this.log.warn(`No id_token in the token response ('openid' scope not granted) - MQTT streaming will not be able to authenticate.`);
          }

          // Create BMW CarData auth objects
          await this.extendObject('cardataauth', {
            type: 'channel',
            common: {
              name: 'BMW CarData OAuth2',
            },
            native: {},
          });
          await this.extendObject('cardataauth.session', {
            type: 'state',
            common: {
              name: 'OAuth2 Session',
              type: 'string',
              role: 'value',
              read: true,
              write: false,
            },
            native: {},
          });

          await this.setState('cardataauth.session', JSON.stringify(this.session), true);
          this.setState('info.connection', true, true);
          this.log.info(`BMW CarData authorization successful!`);

          // Mark this as an initial login so basicData will be fetched
          this.initialLogin = true;

          return true;
        } catch (error) {
          const errorCode = error.response?.data?.error;
          const status = error.response?.status;
          this.log.debug(`Token polling error (status ${status ?? 'n/a'}): ${errorCode || error.message}`);

          // Terminal OAuth errors (RFC 8628): stop polling.
          if (errorCode === 'expired_token') {
            this.log.error(`Authorization code expired, please restart adapter`);
            return false;
          } else if (errorCode === 'access_denied') {
            // access_denied is also returned when the CarData services are not
            // subscribed to the Client ID, so do not blame the user exclusively.
            this.log.error(
              `Authorization denied by BMW (access_denied). Either you declined/cancelled the consent in the BMW portal, or the CarData services are not subscribed to this Client ID. Fix: in the BMW portal subscribe to CarData API AND CarData Streaming, then delete and recreate the Client ID and re-authorize within 5 minutes.`,
            );
            return false;
          }

          // Still-waiting states: keep polling. BMW returns HTTP 403 while the
          // user has not yet completed authorization (Device Code Flow swagger v1.6),
          // so a 403 without a terminal error code is treated as "still pending".
          if (errorCode === 'authorization_pending' || (status === 403 && !errorCode)) {
            this.log.debug(`Authorization still pending, continuing to poll...`);
            continue;
          } else if (errorCode === 'slow_down') {
            this.log.debug(`Rate limit hit, slowing down polling...`);
            await this.sleep(5000); // Additional delay
            continue;
          }

          // Transient errors (5xx backend hiccups or network errors with no
          // response) should NOT abort the flow - keep polling until the deadline.
          // This prevents the adapter from restarting the whole device flow on a
          // temporary BMW backend error (e.g. HTTP 500 invalid_access_token).
          if (!error.response || status >= 500) {
            this.log.warn(
              `Transient token polling error (status ${status ?? 'n/a'}): ${JSON.stringify(error.response?.data) || error.message} - continuing to poll`,
            );
            continue;
          }

          // Unknown client error (4xx): log full details and stop.
          this.log.error(`Token request failed: ${errorCode || error.message}`);
          if (error.response) {
            this.log.error(`Token response status: ${status}`);
            this.log.error(`Token response data: ${JSON.stringify(error.response.data)}`);
          }
          return false;
        }
      }

      this.log.error('Authorization timed out');
      return false;
    } catch (error) {
      this.log.error(`Device flow failed: ${error.message}`);
      this.log.error(`Error stack: ${error.stack}`);
      if (error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response headers: ${JSON.stringify(error.response.headers)}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
      if (error.request) {
        this.log.error(
          `Request details: ${JSON.stringify({
            method: error.request.method,
            url: error.request.url,
            headers: error.request._headers,
          })}`,
        );
      }
      return false;
    }
  }

  async getVehiclesv2(firstStart) {
    const headers = {
      Authorization: `Bearer ${this.session.access_token}`,
      'x-version': 'v1',
      Accept: 'application/json',
    };

    this.log.debug('Fetching BMW CarData vehicle mappings');
    await this.makeCarDataApiRequest(
      {
        method: 'get',
        url: `${this.carDataApiBase}/customers/vehicles/mappings`,
        headers: headers,
      },
      'fetch vehicle mappings',
    )
      .then(async res => {
        this.log.debug(JSON.stringify(res.data));
        const mappings = res.data;

        if (firstStart) {
          this.log.info(`Found ${mappings.length} BMW vehicles`);
        }

        if (mappings.length === 0) {
          this.log.info(`No BMW vehicles found in CarData mappings`);
          return;
        }

        for (const mapping of mappings) {
          if (mapping.vin) {
            const vin = mapping.vin;

            // Check ignore list
            if (this.config.ignorelist) {
              const ignoreListArray = this.config.ignorelist.replace(/\s/g, '').split(',');
              if (ignoreListArray.includes(vin)) {
                this.log.info(`Ignoring ${vin} (in ignore list)`);
                continue;
              }
            }

            this.vinArray.push(vin);
            this.log.info(`Added vehicle: ${vin}`);
            if (firstStart) {
              this.cleanObjects(vin);
            }

            // Create complete vehicle structure (device, states, channels, and remotes)
            await this.createVehicleStates(vin);

            // Fetch basicData only after real login (not adapter restart)
            if (this.initialLogin) {
              try {
                await this.handleRemoteApiCall(vin, 'basicData');
                this.log.info(`✓ BasicData fetched for ${vin} after initial login`);
              } catch (error) {
                this.log.warn(`Failed to fetch basicData for ${vin} after initial login: ${error.message}`);
              }
            }
          }
        }
      })
      .catch(error => {
        this.log.error(`BMW CarData vehicle discovery failed: ${error.message}`);
        if (error.response) {
          this.log.error(`Response: ${JSON.stringify(error.response.data)}`);
          if (error.response.status === 403 || error.response.status === 429) {
            this.log.warn(`Rate limit exceeded or access denied`);
          }
        }
      });

    // Reset initialLogin flag after processing all vehicles
    if (this.initialLogin) {
      this.initialLogin = false;
      this.log.info(`Initial login basicData fetching completed`);
    }

    await this.sleep(2000);
  }

  /**
   * Create complete vehicle structure including basic states and remote buttons
   *
   * @param {string} vin - The vehicle VIN
   */
  async createVehicleStates(vin) {
    // Create vehicle device
    await this.extendObject(vin, {
      type: 'device',
      common: {
        name: vin, // Will be updated with model name when basic data is fetched
      },
      native: {},
    });

    // Create VIN state
    await this.extendObject(`${vin}.vin`, {
      type: 'state',
      common: {
        name: 'Vehicle Identification Number',
        type: 'string',
        role: 'info.vin',
        read: true,
        write: false,
      },
      native: {},
    });
    await this.setState(`${vin}.vin`, vin, true);

    // Create main folder structure
    await this.extendObject(`${vin}.api`, {
      type: 'channel',
      common: {
        name: 'API Data (Periodic Updates)',
      },
      native: {},
    });

    await this.extendObject(`${vin}.stream`, {
      type: 'channel',
      common: {
        name: 'Stream Data (Real-time MQTT)',
      },
      native: {},
    });

    // Create lastAPIUpdate state for telematic API updates
    await this.extendObject(`${vin}.lastStreamViaAPIUpdate`, {
      type: 'state',
      common: {
        name: 'Last Stream data update via Telematic API',
        type: 'string',
        role: 'date',
        read: true,
        write: false,
      },
      native: {},
    });

    // Create lastStreamUpdate state for MQTT updates
    await this.extendObject(`${vin}.lastStreamUpdate`, {
      type: 'state',
      common: {
        name: 'Last Stream Update Time',
        type: 'string',
        role: 'date',
        read: true,
        write: false,
      },
      native: {},
    });

    // Create remote control structure with buttons for all API endpoints
    await this.extendObject(`${vin}.remote`, {
      type: 'channel',
      common: {
        name: 'Remote Controls',
      },
      native: {},
    });

    // Define available API endpoints (BMW CarData API v1)
    const apiEndpoints = [
      {
        name: 'fetchViaAPI',
        label: 'Fetch Telematic Data via API into stream',
        desc: 'Trigger fetching telematic container data for this vehicle',
      },
      {
        name: 'basicData',
        label: 'Fetch Basic Data',
        desc: 'Fetch vehicle information, model, brand, series, VIN details',
      },
      {
        name: 'chargingHistory',
        label: 'Fetch Charging History',
        desc: 'Fetch charging sessions and history data',
      },
      {
        name: 'image',
        label: 'Fetch Vehicle Image',
        desc: 'Fetch vehicle image for display purposes',
      },
      {
        name: 'locationBasedChargingSettings',
        label: 'Fetch Location Based Charging Settings',
        desc: 'Fetch location-specific charging preferences and settings',
      },
      {
        name: 'smartMaintenanceTyreDiagnosis',
        label: 'Fetch Smart Maintenance Tyre Diagnosis',
        desc: 'Fetch smart maintenance system tyre condition and diagnosis data',
      },
    ];

    // Create remote buttons for all endpoints
    for (const endpoint of apiEndpoints) {
      await this.extendObject(`${vin}.remote.${endpoint.name}`, {
        type: 'state',
        common: {
          name: endpoint.label,
          type: 'boolean',
          role: 'button',
          read: false,
          write: true,
          desc: endpoint.desc,
        },
        native: {},
      });
    }
    this.delObjectAsync(`${vin}.lastUpdate`);
  }

  updateQuotaStates() {
    const now = Date.now();
    if (!this.apiCalls) {
      this.apiCalls = [];
    }

    // Remove calls older than 24h
    const originalLength = this.apiCalls.length;
    this.apiCalls = this.apiCalls.filter(time => now - time < 24 * 60 * 60 * 1000);

    // Save history if calls were removed due to expiration
    if (this.apiCalls.length !== originalLength) {
      this.setState('info.apiCallsHistory', JSON.stringify(this.apiCalls), true);
    }

    const used = this.apiCalls.length;
    const remaining = API_QUOTA_LIMIT - used;
    // Quota states removed - using only apiCallsHistory for persistence

    return { used, remaining };
  }

  checkQuota() {
    const { used, remaining } = this.updateQuotaStates();

    if (remaining > 0) {
      this.apiCalls.push(Date.now());

      // Keep only the last API_QUOTA_LIMIT API calls (or 24h, whichever is more restrictive)
      if (this.apiCalls.length > API_QUOTA_LIMIT) {
        this.apiCalls = this.apiCalls.slice(-API_QUOTA_LIMIT);
      }

      // Save API calls history for persistence
      this.setState('info.apiCallsHistory', JSON.stringify(this.apiCalls), true);
      return true;
    }

    this.log.warn(`API quota for api data exhausted: ${used}/${API_QUOTA_LIMIT} calls used in last 24h. Stream data still working.`);
    return false;
  }

  /**
   * Make a CarData API request with automatic quota tracking and warning
   *
   * @param {object} requestConfig - Axios request configuration
   * @param {string} operationName - Name of the operation for logging
   */
  async makeCarDataApiRequest(requestConfig, operationName = 'API request') {
    try {
      // Check quota and warn if exhausted, but continue anyway
      const quotaAvailable = this.checkQuota();
      if (!quotaAvailable) {
        this.log.warn(`API quota exhausted for ${operationName} - continuing anyway`);
      }

      // Make the API request
      const response = await this.requestClient(requestConfig);

      if (quotaAvailable) {
        this.log.debug(`✓ ${operationName} completed successfully`);
      } else {
        this.log.debug(`✓ ${operationName} completed successfully (over quota)`);
      }

      return response;
    } catch (error) {
      this.log.error(`${operationName} failed: ${error.message}`);
      if (error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
      throw error; // Re-throw to maintain existing error handling
    }
  }

  /**
   * Initialize descriptions and states from telematic.json
   */
  initializeTelematicData() {
    try {
      const telematicData = JSON.parse(fs.readFileSync(path.join(__dirname, 'telematic.json'), 'utf8'));

      telematicData.forEach(item => {
        if (item.technical_identifier && item.cardata_element) {
          this.description[item.technical_identifier] = item.cardata_element;
          if (Array.isArray(item.typical_value_range)) {
            this.states[item.technical_identifier] = item.typical_value_range;
          }
        }
      });

      this.log.info(`Initialized ${Object.keys(this.description).length} descriptions, ${Object.keys(this.states).length} states`);
    } catch (error) {
      this.log.error(`Error initializing telematic data: ${error.message}`);
    }
  }

  /**
   * Pauses execution for a specified duration.
   *
   * @param {number} ms - The duration to pause in milliseconds.
   */
  sleep(ms) {
    return new Promise(resolve => this.setTimeout(() => resolve(undefined), ms));
  }

  /**
   * Function to clean up old states from previous adapter versions
   *
   * @param {string} vin - The vehicle VIN
   */
  async cleanObjects(vin) {
    // Check if this is an upgrade from old version by looking for remotev2 states
    const remoteState = await this.getObjectAsync(`${vin}.remotev2`);
    if (remoteState) {
      this.log.info(`Cleaning old states for ${vin} (upgrading from previous version)`);

      // Delete all old state structures recursively
      await this.delObjectAsync(vin, { recursive: true });

      // Create fresh vehicle device
      await this.extendObject(vin, {
        type: 'device',
        common: { name: vin },
        native: {},
      });
    } else {
      // Standard cleanup for existing CarData installations
      const oldProperties = await this.getObjectAsync(`${vin}.properties`);
      if (oldProperties) {
        this.log.debug(`Clean old states ${vin}`);
        await this.delObjectAsync(`${vin}.statusv1`, { recursive: true });
        await this.delObjectAsync(`${vin}.lastTrip`, { recursive: true });
        await this.delObjectAsync(`${vin}.allTrips`, { recursive: true });
        await this.delObjectAsync(`${vin}.status`, { recursive: true });
        await this.delObjectAsync(`${vin}.properties`, { recursive: true });
        await this.delObjectAsync(`${vin}.capabilities`, { recursive: true });
        await this.delObjectAsync(`${vin}.chargingprofile`, { recursive: true });
        await this.delObjectAsync(`${vin}.serviceExecutionHistory`, { recursive: true });
        await this.delObjectAsync(`${vin}.apiV2`, { recursive: true });
        await this.delObjectAsync(`${vin}.remote`, { recursive: true });
      }
    }

    // Clean up old global states
    await this.delObjectAsync(`_DatenNeuLaden`);
    await this.delObjectAsync(`_LetzterDatenabrufOK`);
    await this.delObjectAsync(`_LetzerFehler`);

    // Clean up old authentication objects (v3.x used different auth structure)
    const oldAuthObjects = await this.getObjectAsync(`auth`);
    if (oldAuthObjects) {
      this.log.info(`Cleaning up complete old auth folder from previous version`);
      await this.delObjectAsync(`auth`, { recursive: true });
    }
  }

  async refreshToken() {
    if (!this.session.refresh_token) {
      this.log.error('No refresh token available, starting new device flow');
      return await this.login();
    }

    this.log.debug(`Refreshing BMW CarData tokens`);
    this.log.debug(`Refresh token URL: ${this.authApiBase}/token`);
    this.log.debug(`Client ID: ${this.config.clientId}`);

    const refreshData = {
      grant_type: 'refresh_token',
      refresh_token: this.session.refresh_token,
      client_id: this.config.clientId,
    };
    this.log.debug(`Refresh request data: ${JSON.stringify(refreshData)}`);

    await this.requestClient({
      method: 'post',
      url: `${this.authApiBase}/token`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: qs.stringify(refreshData),
    })
      .then(async res => {
        // Store refreshed tokens (keep existing session structure). Preserve the gcid if the
        // refresh response omits it - MQTT needs it as the username on auto-reconnect.
        const previousGcid = this.session?.gcid;
        this.session = res.data;
        if (!this.session.gcid && previousGcid) {
          this.session.gcid = previousGcid;
        }
        this.setState(`cardataauth.session`, JSON.stringify(this.session), true);
        this.setState(`info.connection`, true, true);
        this.log.debug(`Tokens refreshed successfully - MQTT will auto-reconnect with new credentials`);
        this.mqtt?.options && (this.mqtt.options.password = this.session.id_token);
        return res.data;
      })
      .catch(async error => {
        // Log complete error object first
        this.log.error(error);

        // HTTP response errors - check status code
        if (error.response) {
          this.log.error(`Response status: ${JSON.stringify(error.response.data)}`);
          const status = error.response.status;
          if (status >= 400 && status < 500) {
            // 4xx errors indicate authentication problems - reset needed
            this.log.error(`Token refresh failed with HTTP ${status} auth error - starting new device flow`);
            this.setState(`info.connection`, false, true);
            return await this.login();
          }
        }

        this.log.warn(`Token refresh failed, will retry on next refresh cycle. You can also delete bmw.0.cardataauth.session state to force re-login.`);
        this.setState(`info.connection`, false, true);
        return;
      });
  }

  async connectMQTT() {
    if (!this.session.id_token) {
      this.log.warn(`No MQTT credentials available (missing ID token)`);
      return false;
    }

    // BMW's streaming broker authenticates with the id_token as password and expects the
    // account's gcid as the MQTT username. The topic ACL only permits '{gcid}/#', so
    // subscribing under anything else is refused with "Unspecified error" (SUBACK failure)
    // even though the connection succeeds. The gcid is returned in the token response.
    const mqttUsername = this.session.gcid;
    if (!mqttUsername) {
      this.log.error(`No gcid in the session - MQTT streaming cannot authenticate. Re-authorize the adapter to obtain the gcid from the token.`);
      return false;
    }

    const mqtt = require('mqtt');

    //export interface IClientOptions extends ISecureClientOptions {
    const brokerUrl = 'mqtts://customer.streaming-cardata.bmwgroup.com:9000';
    const options = {
      username: mqttUsername,
      password: this.session.id_token,
      keepalive: 30,
      clean: true,
      rejectUnauthorized: true,
      reconnectPeriod: 30000, // Built-in reconnection every 30 seconds
      connectTimeout: 30000,
    };

    this.log.debug(`Connecting to BMW MQTT: ${brokerUrl}`);
    this.log.debug(`MQTT Username (gcid): ${mqttUsername}`);
    this.mqtt = mqtt.connect(brokerUrl, options);

    this.mqtt.on('connect', () => {
      this.log.info(`BMW MQTT stream connected`);
      this.setState(`info.mqttConnected`, true, true);

      // Subscribe to all vehicle topics for this account. The topic prefix is the gcid,
      // matching the username; '{gcid}/+' delivers every VIN mapped to the account.
      const topic = `${mqttUsername}/+`;
      this.mqtt?.subscribe(topic, err => {
        if (err) {
          this.log.error(`MQTT subscription failed: ${err.message}`);
        } else {
          this.log.debug(`Subscribed to MQTT topic: ${topic}`);
        }
      });
    });

    this.mqtt.on('message', (topic, message) => {
      this.handleMQTTMessage(topic, message);
    });

    this.mqtt.on('error', async error => {
      this.setState('info.mqttConnected', false, true);

      // Check if it's a connection timeout (server not reachable)
      if (error.message && error.message.includes('connack timeout')) {
        this.log.warn(`BMW MQTT server not reachable (Connack timeout) - will retry automatically`);
        return;
      }

      // Check if it's an authentication error indicating expired token
      if (
        error.message &&
        (error.message.includes('Bad username or password') || error.message.includes('Connection refused') || error.message.includes('Not authorized'))
      ) {
        this.log.warn(`MQTT authentication failed - refreshing token for next auto-reconnect`);
        try {
          await this.refreshToken();
          this.log.debug(`Token refreshed - MQTT client will auto-reconnect with new credentials`);
        } catch (refreshError) {
          this.log.error(`Token refresh failed: ${refreshError}`);
          this.log.warn(`MQTT will retry connection with current token via built-in reconnection`);
        }
      } else {
        this.log.error(`MQTT error: ${error}`);
        this.log.debug(`Non-authentication MQTT error - letting built-in client handle reconnection`);
      }
    });

    this.mqtt.on('close', () => {
      this.log.info('MQTT connection closed');
      this.setState('info.mqttConnected', false, true);
    });

    this.mqtt.on('reconnect', () => {
      this.log.info('MQTT reconnecting...');
    });

    return true;
  }

  async handleMQTTMessage(topic, message) {
    try {
      const data = JSON.parse(message.toString());
      this.log.debug(`MQTT message on ${topic}: ${JSON.stringify(data)}`);
      const topicParts = topic.split('/');

      if (topicParts.length >= 2) {
        /*
   34ddc38-93220-423330-93101-fcd292373/WBY11HH: {"vin":"WBY11HH","entityId":"34ddc38-93220-423330-93101-fcd292373","topic":"WBY11HH","timestamp":"2025-10-01T10:12:40.809Z","data":{"vehicle.powertrain.electric.battery.charging.preferenceSmartCharging":{"timestamp":"2025-10-01T10:12:39Z","value":"PRICE_OPTIMIZED"}}}
   */
        const vin = topicParts[1];

        if (data.vin && data.data) {
          this.log.debug(`MQTT: ${vin} - ${Object.keys(data.data).length} data points`);

          // Ensure VIN is in our array and create structure if new
          if (!this.vinArray.includes(vin)) {
            this.vinArray.push(vin);
            // Create complete vehicle structure for newly discovered vehicle
            await this.createVehicleStates(vin);
          }

          // Process data in stream/ folder with json2iob
          await this.json2iob.parse(`${vin}.stream`, data.data, {
            forceIndex: true,
            descriptions: this.description,
            states: this.states,
            channelName: 'MQTT Stream Data',
            autoCast: true,
            useCompletePathForDescriptionsAndStates: true,
          });

          await this.setState(`${vin}.lastStreamUpdate`, new Date().toISOString(), true);

          // Check for position updates and trigger reverse geocoding
          this.checkPositionFromData(vin, data.data);
        }
      }
    } catch (error) {
      this.log.warn(`Failed to parse MQTT message: ${error.message}`);
    }
  }

  /**
   * Check for position data and trigger reverse geocoding if available
   *
   * @param {string} vin - The vehicle VIN
   * @param {object} data - The data object containing telematic data
   */
  checkPositionFromData(vin, data) {
    if (!this.config.reverseGeocode) {
      return;
    }

    const latKey = 'vehicle.cabin.infotainment.navigation.currentLocation.latitude';
    const lonKey = 'vehicle.cabin.infotainment.navigation.currentLocation.longitude';

    const latData = data[latKey];
    const lonData = data[lonKey];

    if (latData?.value != null && lonData?.value != null) {
      const latitude = parseFloat(latData.value);
      const longitude = parseFloat(lonData.value);

      if (!isNaN(latitude) && !isNaN(longitude)) {
        this.checkAndTriggerReverseGeocode(vin, latitude, longitude);
      }
    }
  }

  /**
   * Clean up existing containers that start with "ioBroker"
   */
  async cleanupAllContainers() {
    try {
      const headers = {
        Authorization: `Bearer ${this.session.access_token}`,
        'x-version': 'v1',
        Accept: 'application/json',
      };

      this.log.info(`Cleaning up existing ioBroker containers...`);

      // Get all existing containers
      const response = await this.makeCarDataApiRequest(
        {
          method: 'get',
          url: `${this.carDataApiBase}/customers/containers`,
          headers: headers,
        },
        'list containers',
      );

      const containers = response.data.containers || [];
      const ioBrokerContainers = containers;

      this.log.info(`Found ${containers.length} total containers, ${ioBrokerContainers.length} ioBroker containers to delete`);

      // Delete only ioBroker containers
      for (const container of ioBrokerContainers) {
        try {
          await this.makeCarDataApiRequest(
            {
              method: 'delete',
              url: `${this.carDataApiBase}/customers/containers/${container.containerId}`,
              headers: headers,
            },
            `delete container ${container.containerId}`,
          );
          this.log.debug(`Deleted ioBroker container: ${container.containerId} (${container.name})`);
        } catch (error) {
          this.log.warn(`Failed to delete container ${container.containerId}: ${error.message}`);
        }
      }

      this.log.info(`Container cleanup completed - deleted ${ioBrokerContainers.length} ioBroker containers`);
      return true;
    } catch (error) {
      this.log.error(`Failed to cleanup containers: ${error.message}`);
      if (error.response) {
        this.log.error(`Response: ${JSON.stringify(error.response.data)}`);
      }
      return false;
    }
  }

  /**
   * Create a new telematic container. Uses all technical identifiers from
   * telematic.json, or a reduced curated set when config.reducedContainer is enabled
   * (in which case all existing containers are deleted first).
   */
  async createTelematicContainer() {
    try {
      const reducedContainer = this.config.reducedContainer === true;

      // In reduced mode, always start clean: delete all existing containers and
      // create a fresh reduced container. This avoids reusing a previously created
      // full container and frees up the 10-container limit.
      if (reducedContainer) {
        this.log.info(`Reduced container mode enabled - deleting all existing containers before creating a reduced one`);
        await this.cleanupAllContainers();
        await this.delObjectAsync('containerInfo.containerId').catch(() => {});
        this.containerId = null;
      }

      // Check if we already have a stored container ID (skipped in reduced mode)
      const storedContainerId = reducedContainer ? null : await this.getStateAsync('containerInfo.containerId');
      if (storedContainerId && storedContainerId.val) {
        this.containerId = storedContainerId.val;
        this.log.info(`Using existing container ID: ${this.containerId}`);

        // Test if the existing container is still valid by attempting real telematic data fetching
        try {
          // Container exists, now test with real telematic data fetching if we have vehicles
          if (this.vinArray && this.vinArray.length > 0) {
            this.log.debug(`Testing container ${this.containerId} with real telematic data fetch`);

            // Try to validate container by fetching data for any available vehicle
            let containerValid = false;
            for (const vin of this.vinArray) {
              try {
                const telematicData = await this.getTelematicContainer(vin, this.containerId);
                if (telematicData && telematicData.telematicData) {
                  // Store validation data directly in stream folder to avoid duplicate API call
                  await this.json2iob.parse(`${vin}.stream`, telematicData.telematicData, {
                    descriptions: this.description,
                    states: this.states,
                    autoCast: true,
                    forceIndex: true,
                    useCompletePathForDescriptionsAndStates: true,
                  });

                  // Update lastAPIUpdate timestamp
                  await this.setState(`${vin}.lastStreamViaAPIUpdate`, new Date().toISOString(), true);

                  this.log.info(`Existing container is valid and working - retrieved ${Object.keys(telematicData.telematicData).length} telematic data points`);
                  containerValid = true;
                  break; // Container is valid, no need to test other vehicles
                }
              } catch (vinError) {
                this.log.debug(`Container validation failed for ${vin}: ${vinError.message}`);
                // Continue testing with other vehicles
              }
            }

            if (containerValid) {
              return true;
            }
            this.log.warn(`Container exists but failed to retrieve telematic data for any vehicle, will recreate`);
          } else {
            this.log.info(`Existing container exists, reusing it (no vehicles available for telematic test)`);
            return true;
          }
        } catch (validationError) {
          this.log.warn(`Existing container ID ${this.containerId} validation failed: ${validationError.message}`);
          this.log.info(`Will create a new container`);
        }
      }

      const headers = {
        Authorization: `Bearer ${this.session.access_token}`,
        'x-version': 'v1',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };

      // List existing containers before creating a new one. BMW allows a maximum of
      // 10 containers per user (CU-124); at the limit, creation fails. Logging the
      // current containers also helps diagnose CU-403 issues. Skipped in reduced mode
      // because all containers were already deleted above.
      if (!reducedContainer) {
        try {
          const listResponse = await this.makeCarDataApiRequest(
            {
              method: 'get',
              url: `${this.carDataApiBase}/customers/containers`,
              headers: headers,
            },
            'list containers',
          );
          const existingContainers = listResponse.data?.containers || [];
          const activeCount = existingContainers.filter(c => c.state === 'ACTIVE').length;
          this.log.info(`Found ${existingContainers.length}/10 existing containers (${activeCount} ACTIVE) before creating a new one`);
          for (const c of existingContainers) {
            this.log.debug(`Existing container: ${c.containerId} state=${c.state} name=${c.name}`);
          }
          if (existingContainers.length >= 10) {
            this.log.warn(`Container limit (10) reached. Cleaning up existing containers before creating a new one.`);
            await this.cleanupAllContainers();
          }
        } catch (listError) {
          // Non-fatal: continue to creation, which will surface the real error.
          this.log.warn(`Could not list existing containers before creation: ${listError.message}`);
        }
      }

      // Read telematic.json file
      const fs = require('node:fs');
      const path = require('node:path');
      const telematicPath = path.join(__dirname, 'telematic.json');

      if (!fs.existsSync(telematicPath)) {
        this.log.error(`telematic.json file not found`);
        return false;
      }

      const telematicData = JSON.parse(fs.readFileSync(telematicPath, 'utf8'));

      // Full set = all catalogue keys from telematic.json; reduced set = small curated set
      // that BMW reliably accepts. Filter out any undefined/null identifiers.
      const fullDescriptors = telematicData.map(item => item.technical_identifier).filter(identifier => identifier);

      // POST a new container with the given descriptors and return the API response so the
      // caller can persist the containerId.
      const postContainer = (descriptors, label) =>
        this.makeCarDataApiRequest(
          {
            method: 'post',
            url: `${this.carDataApiBase}/customers/containers`,
            headers: headers,
            data: {
              name: `ioBroker BMW Telematic Data - ${new Date().toISOString()}`,
              purpose: `${label} for BMW telematic data used by ioBroker adapter`,
              technicalDescriptors: descriptors,
            },
          },
          'create telematic container',
        );

      let response;
      if (reducedContainer) {
        this.log.info(`Creating REDUCED container with ${REDUCED_TELEMATIC_KEYS.length} technical identifiers`);
        response = await postContainer(REDUCED_TELEMATIC_KEYS, 'Reduced container');
      } else {
        this.log.info(`Creating container with ${fullDescriptors.length} technical identifiers from telematic.json`);
        try {
          response = await postContainer(fullDescriptors, 'Container');
        } catch (fullError) {
          const status = fullError.response?.status;
          const exveErrorId = fullError.response?.data?.exveErrorId;
          // BMW refuses a fresh full-catalogue container with CU-403 (HTTP 403), while the
          // curated reduced set is accepted. Fall back to it automatically so the adapter
          // still ends up with a working container instead of no telematic data at all.
          if (status === 403) {
            this.log.warn(
              `Full container creation refused by BMW (${exveErrorId || 'HTTP 403'}). Falling back to a reduced container with ${REDUCED_TELEMATIC_KEYS.length} keys. Enable the "reduced container" option to skip this attempt.`,
            );
            response = await postContainer(REDUCED_TELEMATIC_KEYS, 'Reduced container (auto-fallback)');
          } else {
            throw fullError;
          }
        }
      }

      this.containerId = response.data.containerId;
      this.log.info(`Container created successfully with ID: ${this.containerId}`);
      this.log.debug(`Container details: ${JSON.stringify(response.data)}`);

      // Store container ID in adapter state for persistence
      await this.extendObject('containerInfo', {
        type: 'channel',
        common: {
          name: 'Container Information',
        },
        native: {},
      });

      await this.extendObject('containerInfo.containerId', {
        type: 'state',
        common: {
          name: 'Container ID',
          type: 'string',
          role: 'info',
          read: true,
          write: false,
        },
        native: {},
      });

      await this.setState('containerInfo.containerId', this.containerId, true);

      // Fetch initial telematic data for all vehicles with new container
      for (const vin of this.vinArray) {
        this.log.info(`Fetching initial telematic data for ${vin} using new container`);
        try {
          const telematicData = await this.getTelematicContainer(vin, this.containerId);
          if (telematicData && telematicData.telematicData) {
            // Store telematic data directly in stream folder
            await this.json2iob.parse(`${vin}.stream`, telematicData.telematicData, {
              descriptions: this.description,
              states: this.states,
              autoCast: true,

              useCompletePathForDescriptionsAndStates: true,
              forceIndex: true,
            });

            // Update lastAPIUpdate timestamp
            await this.setState(`${vin}.lastStreamViaAPIUpdate`, new Date().toISOString(), true);

            this.log.info(`✓ Initial telematic data fetched for ${vin}: ${Object.keys(telematicData.telematicData).length} data points`);
          } else {
            this.log.warn(`No initial telematic data retrieved for ${vin}`);
          }
        } catch (error) {
          this.log.error(`Failed to fetch initial telematic data for ${vin}: ${error.message}`);
        }
      }
      return true;
    } catch (error) {
      this.log.error(`Failed to create telematic container: ${error.message}`);
      if (error.response) {
        const status = error.response.status;
        const exveErrorId = error.response.data?.exveErrorId;
        this.log.error(`Response status: ${status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
        this.log.error(`Token scope on this session: ${this.session?.scope || 'unknown'}`);

        // Targeted hints (CarData Integration Guide v1.6).
        if (status === 403) {
          const hasApiScope = this.session?.scope?.includes('cardata:api:read');
          if (exveErrorId === 'CU-103' || !hasApiScope) {
            // CU-103 "The token-scope is not CarData": the token was granted without
            // cardata:api:read. Either the device-code request omitted the scope, or the
            // Client ID is not subscribed to the CarData API in the BMW portal.
            this.log.error(
              `HTTP 403 (${exveErrorId || 'CU-103'}) - the token was not granted the CarData scope (granted: ${this.session?.scope || 'unknown'}). Subscribe to the CarData API for this Client ID in the BMW portal, then delete the Client ID and re-authorize.`,
            );
          } else {
            this.log.error(
              `HTTP 403 (${exveErrorId || 'CU-403'}) on container creation although the token has 'cardata:api:read'. This is a BMW-side authorization refusal on the container endpoint, not a data problem. Known checklist: (1) both CarData API AND CarData Streaming subscribed to this Client ID, (2) you are the PRIMARY user of the VIN, (3) fewer than 10 containers exist on the account. If all apply, this is likely a BMW backend/entitlement issue - report it with this log.`,
            );
          }
        } else if (exveErrorId === 'CU-124') {
          this.log.error(
            `Container limit reached (max 10 per user). Delete unused containers - the adapter can clean up its own containers via cleanupAllContainers.`,
          );
        }
      }
      return false;
    }
  }

  /**
   * Get telematic container data for a specific vehicle
   *
   * @param {string} vin - The vehicle VIN
   * @param {string} containerId - The container ID to retrieve data from
   */
  async getTelematicContainer(vin, containerId) {
    try {
      const headers = {
        Authorization: `Bearer ${this.session.access_token}`,
        'x-version': 'v1',
        Accept: 'application/json',
      };

      this.log.debug(`Retrieving telematic data for VIN: ${vin}, Container ID: ${containerId}`);

      const response = await this.makeCarDataApiRequest(
        {
          method: 'get',
          url: `${this.carDataApiBase}/customers/vehicles/${vin}/telematicData`,
          headers: headers,
          params: {
            containerId: containerId,
          },
        },
        `get telematic data for ${vin}`,
      );

      // Filter out telematic data entries with null timestamps (not relevant for the car)
      if (response.data.telematicData) {
        const originalCount = Object.keys(response.data.telematicData).length;
        const filteredTelematicData = {};

        for (const [key, data] of Object.entries(response.data.telematicData)) {
          if (data.timestamp !== null || data.value !== null) {
            filteredTelematicData[key] = data;
          }
        }

        response.data.telematicData = filteredTelematicData;
        const filteredCount = Object.keys(filteredTelematicData).length;

        this.log.info(
          `Telematic data retrieved for ${vin}: ${filteredCount} relevant data points (${originalCount - filteredCount} null timestamp entries filtered out)`,
        );
      } else {
        this.log.info(`Telematic data retrieved successfully for ${vin} (no telematicData in response)`);
      }

      this.log.debug(`Filtered telematic data: ${JSON.stringify(response.data)}`);

      return response.data;
    } catch (error) {
      this.log.error(`Failed to retrieve telematic data for ${vin} with container ${containerId}: ${error.message}`);
      if (error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);

        if (error.response.status === 404) {
          this.log.warn(`Telematic data not found for VIN ${vin} or container ${containerId} (404)`);
        }
      }
      return null;
    }
  }

  /**
   * Fetch charging history with pagination support
   *
   * @param {string} vin - The vehicle VIN
   * @param {string} fromDate - Start date in ISO format
   * @param {string} toDate - End date in ISO format
   * @param {string|null} nextToken - Optional pagination token
   */
  async fetchChargingHistory(vin, fromDate, toDate, nextToken = null) {
    try {
      const headers = {
        Authorization: `Bearer ${this.session.access_token}`,
        'x-version': 'v1',
        Accept: 'application/json',
      };

      const params = {
        from: fromDate,
        to: toDate,
      };

      if (nextToken) {
        params.nextToken = nextToken;
      }

      this.log.debug(`Fetching charging history for ${vin} from ${fromDate} to ${toDate}${nextToken ? ` (page token: ${nextToken})` : ''}`);

      const response = await this.makeCarDataApiRequest(
        {
          method: 'get',
          url: `${this.carDataApiBase}/customers/vehicles/${vin}/chargingHistory`,
          headers: headers,
          params: params,
        },
        `fetch charging history for ${vin}${nextToken ? ' (paginated)' : ''}`,
      );

      const chargingData = response.data;
      this.log.info(`Retrieved ${chargingData.data?.length || 0} charging sessions for ${vin}`);

      // If there's a next token, fetch additional pages
      let allData = chargingData.data || [];
      if (chargingData.next_token) {
        this.log.debug(`Found next_token, fetching additional charging history pages...`);
        const nextPageData = await this.fetchChargingHistory(vin, fromDate, toDate, chargingData.next_token);
        if (nextPageData && nextPageData.data) {
          allData = allData.concat(nextPageData.data);
        }
      }

      return {
        data: allData,
        totalSessions: allData.length,
      };
    } catch (error) {
      this.log.error(`Failed to fetch charging history for ${vin}: ${error.message}`);
      if (error.response) {
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
      }
      return null;
    }
  }

  /**
   * Setup telematic container by reusing existing one or creating a new one
   */
  async setupTelematicContainer() {
    this.log.info(`Setting up telematic container...`);

    // Try to create/reuse container (cleanup only happens if existing container is invalid)
    const createSuccess = await this.createTelematicContainer();
    if (createSuccess) {
      this.log.info(`Telematic container setup completed. Container ID: ${this.containerId}`);

      // Container validation and data storage already handled in createTelematicContainer()
      // No duplicate API call needed here - saving quota
    } else {
      this.log.error(`Failed to setup telematic container`);
    }

    return createSuccess;
  }

  /**
   * Reverse geocode position using OpenStreetMap Nominatim
   *
   * @param {number} latitude - The latitude value
   * @param {number} longitude - The longitude value
   * @param {string} vin - The vehicle VIN
   */
  async reversePosition(latitude, longitude, vin) {
    this.log.debug(`Reverse geocoding for ${vin}: ${latitude}, ${longitude}`);

    try {
      const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
        params: { lat: latitude, lon: longitude, format: 'json', zoom: 18 },
        headers: { 'User-Agent': 'ioBroker/bmw-adapter' },
        timeout: 10000,
      });

      const body = response.data;
      if (!body?.display_name) {
        this.log.debug(`No address found for ${latitude}, ${longitude}`);
        return;
      }

      const address = body.address || {};
      const road = address.road || address.street || '';
      const number = address.house_number || '';
      const postcode = address.postcode || '';
      const city = address.city || address.town || address.village || address.municipality || '';
      const country = address.country || '';

      let fullAddress = road;
      if (number) {
        fullAddress += ` ${number}`;
      }
      if (city) {
        fullAddress += `, ${postcode ? `${postcode} ` : ''}${city}`;
      }
      if (country) {
        fullAddress += `, ${country}`;
      }

      // Store address data using json2iob
      await this.json2iob.parse(
        `${vin}.position.address`,
        {
          displayName: fullAddress,
          road: road,
          house_number: number,
          postcode: postcode,
          city: city,
          country: country,
          latitude: latitude,
          longitude: longitude,
        },
        { channelName: 'Reverse Geocoded Address' },
      );

      this.log.info(`Address updated for ${vin}: ${fullAddress}`);
    } catch (error) {
      this.log.error(`Reverse geocoding failed: ${error.message}`);
    }
  }

  /**
   * Check and trigger reverse geocoding with debounce
   * Only triggers if position hasn't changed for 30 seconds
   *
   * @param {string} vin - The vehicle VIN
   * @param {number} latitude - Current latitude
   * @param {number} longitude - Current longitude
   */
  checkAndTriggerReverseGeocode(vin, latitude, longitude) {
    if (!this.config.reverseGeocode) {
      return;
    }

    const DEBOUNCE_MS = 30000; // 30 seconds
    const lastPos = this.lastPosition[vin];

    // Check if position has changed
    const positionChanged = !lastPos || lastPos.lat !== latitude || lastPos.lon !== longitude;

    if (positionChanged) {
      // Position changed - update tracking and reset timer
      this.lastPosition[vin] = { lat: latitude, lon: longitude };

      // Clear existing timer
      if (this.reverseGeocodeTimers[vin]) {
        clearTimeout(this.reverseGeocodeTimers[vin]);
      }

      // Set new debounce timer
      this.reverseGeocodeTimers[vin] = this.setTimeout(() => {
        this.log.debug(`Position stable for 30s, triggering reverse geocode for ${vin}`);
        this.reversePosition(latitude, longitude, vin);
      }, DEBOUNCE_MS);

      this.log.debug(`Position changed for ${vin}, debounce timer reset`);
    }
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param {() => void} callback - A function to be called when the adapter shuts down.
   */
  async onUnload(callback) {
    try {
      // Clear all intervals and timeouts
      this.clearInterval(this.updateInterval);
      this.clearInterval(this.refreshTokenInterval);

      // Clear reverse geocode timers
      for (const vin of Object.keys(this.reverseGeocodeTimers)) {
        this.clearTimeout(this.reverseGeocodeTimers[vin]);
      }

      // Close MQTT connection
      if (this.mqtt) {
        this.mqtt.end();
        this.mqtt = null;
      }

      // Update connection states
      this.setState('info.connection', false, true);
      this.setState('info.mqttConnected', false, true);

      callback();
    } catch (e) {
      this.log.error(e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   *
   * @param {string} id - The ID of the state that changed.
   * @param {ioBroker.State | null | undefined} state - The new state value or null if the state was deleted.
   */
  async onStateChange(id, state) {
    if (state && !state.ack) {
      // Handle remote button presses generically
      if (id.includes('.remote.')) {
        const idParts = id.split('.');
        const vin = idParts[idParts.length - 3]; // Extract VIN from the ID (VIN.remote.buttonName)
        const buttonName = idParts[idParts.length - 1]; // Extract button name

        this.log.info(`Remote button ${buttonName} pressed for vehicle ${vin}`);

        try {
          await this.handleRemoteApiCall(vin, buttonName);
        } catch (error) {
          this.log.error(`Failed to handle remote API call ${buttonName} for ${vin}: ${error.message}`);
        }

        // Reset the button state
        this.setState(id, false, true);
        return;
      }

      // For other states: BMW CarData API is read-only, no remote controls available
      this.log.warn(`Remote controls not available in BMW CarData (read-only API)`);
      this.log.info(`BMW CarData only provides vehicle data, no command functionality`);

      // Reset the state to acknowledge it
      this.setState(id, state.val, true);
    }
  }

  /**
   * Handle remote API calls generically based on button name
   *
   * @param {string} vin - Vehicle VIN
   * @param {string} buttonName - Name of the button pressed
   */
  async handleRemoteApiCall(vin, buttonName) {
    const headers = {
      Authorization: `Bearer ${this.session.access_token}`,
      'x-version': 'v1',
      Accept: '*/*',
    };

    switch (buttonName) {
      case 'fetchViaAPI': {
        // Handle telematic data fetching
        if (!this.containerId) {
          this.log.warn('No container ID available, setting up telematic container first...');
          const setupSuccess = await this.setupTelematicContainer();
          if (!setupSuccess) {
            throw new Error('Failed to setup telematic container');
          }
        }

        const telematicData = await this.getTelematicContainer(vin, this.containerId);
        if (telematicData && telematicData.telematicData) {
          // Store telematic data directly in stream folder
          await this.json2iob.parse(`${vin}.stream`, telematicData.telematicData, {
            descriptions: this.description,
            forceIndex: true,
            states: this.states,
            autoCast: true,
            useCompletePathForDescriptionsAndStates: true,
          });

          // Update lastAPIUpdate timestamp
          await this.setState(`${vin}.lastStreamViaAPIUpdate`, new Date().toISOString(), true);

          this.log.info(`Successfully fetched ${Object.keys(telematicData.telematicData).length} telematic data points for ${vin}`);
        } else {
          this.log.warn(`No telematic data retrieved for vehicle ${vin}`);
        }
        break;
      }

      case 'basicData': {
        // Handle basicData endpoint
        const basicResponse = await this.makeCarDataApiRequest(
          {
            method: 'get',
            url: `${this.carDataApiBase}/customers/vehicles/${vin}/basicData`,
            headers: headers,
          },
          `fetch basicData for ${vin}`,
        );

        await this.json2iob.parse(`${vin}.api.basicData`, basicResponse.data, {
          channelName: 'Basic Information',
          descriptions: this.description,
          forceIndex: true,
        });

        // Update vehicle name if we got basic data
        if (basicResponse.data) {
          const vehicleName = `${basicResponse.data.modelName || basicResponse.data.series || vin}`.trim();
          await this.extendObject(vin, {
            type: 'device',
            common: {
              name: vehicleName,
            },
            native: {
              brand: basicResponse.data.brand,
              model: basicResponse.data.modelName,
              series: basicResponse.data.series,
              vin: vin,
            },
          });
          this.log.info(`Updated vehicle name: ${vehicleName} (${vin})`);
        }

        this.log.info(`Successfully fetched basic data for ${vin}`);
        break;
      }

      case 'chargingHistory': {
        // Handle charging history endpoint with pagination
        const now = new Date();
        const fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

        const chargingData = await this.fetchChargingHistory(vin, fromDate.toISOString(), now.toISOString());
        if (chargingData) {
          const responseData = {
            data: chargingData.data,
            totalSessions: chargingData.totalSessions,
            dateRange: {
              from: fromDate.toISOString(),
              to: now.toISOString(),
            },
          };

          await this.json2iob.parse(`${vin}.api.chargingHistory`, responseData, {
            channelName: 'Charging History',
            descriptions: this.description,
            forceIndex: true,
          });

          this.log.info(`Successfully fetched charging history for ${vin}: ${chargingData.totalSessions} sessions`);
        } else {
          throw new Error(`Failed to fetch charging history`);
        }
        break;
      }

      case 'image': {
        // Handle vehicle image endpoint
        //special request to receive raw image data
        const imageResponse = await this.requestClient({
          method: 'get',
          url: `${this.carDataApiBase}/customers/vehicles/${vin}/image`,
          headers: headers,
          responseType: 'arraybuffer', // Important to get raw binary data
        });
        this.apiCalls.push(Date.now());
        this.setState('info.apiCallsHistory', JSON.stringify(this.apiCalls), true);

        if (imageResponse.data) {
          await this.extendObject(`${vin}.api.image`, {
            type: 'state',
            common: {
              name: 'Vehicle Image',
              type: 'string',
              role: 'image',
              read: true,
              write: false,
              desc: 'Base64 encoded vehicle image',
            },
            native: {},
          });
          //convert raw png string to base64
          const base64Image = `data:image/png;base64,${Buffer.from(imageResponse.data, 'binary').toString('base64')}`;
          await this.setState(`${vin}.api.image`, base64Image, true);
        }

        this.log.info(`Successfully fetched vehicle image for ${vin}`);
        break;
      }

      case 'locationBasedChargingSettings': {
        // Handle location-based charging settings endpoint
        const locationResponse = await this.makeCarDataApiRequest(
          {
            method: 'get',
            url: `${this.carDataApiBase}/customers/vehicles/${vin}/locationBasedChargingSettings`,
            headers: headers,
          },
          `fetch locationBasedChargingSettings for ${vin}`,
        );

        await this.json2iob.parse(`${vin}.api.locationBasedChargingSettings`, locationResponse.data, {
          channelName: 'Location Based Charging Settings',
          descriptions: this.description,
          forceIndex: true,
        });

        this.log.info(`Successfully fetched location-based charging settings for ${vin}`);
        break;
      }

      case 'smartMaintenanceTyreDiagnosis': {
        // Handle smart maintenance tyre diagnosis endpoint
        const tyreResponse = await this.makeCarDataApiRequest(
          {
            method: 'get',
            url: `${this.carDataApiBase}/customers/vehicles/${vin}/smartMaintenanceTyreDiagnosis`,
            headers: headers,
          },
          `fetch smartMaintenanceTyreDiagnosis for ${vin}`,
        );

        await this.json2iob.parse(`${vin}.api.smartMaintenanceTyreDiagnosis`, tyreResponse.data, {
          channelName: 'Smart Maintenance Tyre Diagnosis',
          descriptions: this.description,
          forceIndex: true,
        });

        this.log.info(`Successfully fetched smart maintenance tyre diagnosis for ${vin}`);
        break;
      }

      default:
        this.log.warn(`Unknown remote button: ${buttonName}`);
        break;
    }

    await this.delObjectAsync(`${vin}.lastUpdate`);
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options] - Optional adapter configuration options.
   */
  module.exports = options => new Bmw(options);
} else {
  // otherwise start the instance directly
  new Bmw();
}
