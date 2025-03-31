'use strict';

// The adapter-core module gives you access to the core ioBroker functions you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;

const { HttpsCookieAgent } = require('http-cookie-agent/http');
const crypto = require('crypto');
const qs = require('qs');
const Json2iob = require('json2iob');
const tough = require('tough-cookie');
const axiosRetry = require('axios-retry').default;
class Bmw extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'bmw',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.userAgent = 'My%20BMW/8932 CFNetwork/978.0.7 Darwin/18.7.0';
    this.userAgentDart = 'Dart/3.3 (dart:io)';
    this.xuserAgent = 'android(AP2A.240605.024);brand;4.99.9(96892);row';
    this.updateInterval;
    this.reLoginTimeout;
    this.refreshTokenInterval;
    this.vinArray = [];
    this.session = {};
    this.statusBlock = {};
    this.nonChargingHistory = {};
    this.json2iob = new Json2iob(this);
    this.lastChargingSessionUpdate = 0;
    this.description = {
      allTrips: 'alle Fahrten des Autos',
      avgCombinedConsumption: 'Durchschnittlicher kombinierter Verbrauch',
      communityAverage: 'Gesamt Durchschnitt',
      communityHigh: 'Gesamt max.',
      communityLow: 'Gesamt min.',
      userAverage: 'Fahrer Durchschnitt',
      avgElectricConsumption: 'Durchschnittlicher elektrischer Verbrauch',
      avgRecuperation: 'Durchschnittliche Rekuperation',
      chargecycleRange: 'Ladezyklus Reichweite',
      userCurrentChargeCycle: 'aktueller Ladezyklus',
      userHigh: 'Fahrer max.',
      totalElectricDistance: 'gesamte elektrische Distanz',
      batterySizeMax: 'max. Batterie Ladeleistung in Wh',
      resetDate: 'Werte zur+ckgesetz am',
      savedCO2: 'Eingespartes CO2',
      savedCO2greenEnergy: 'Eingespartes CO2 grüne Energie',
      totalSavedFuel: 'Gesamt gesparter Kraftstoff',
      apiV2: 'limitierte v2 Api des Autos',
      basicType: 'Grundtyp',
      bodyType: 'Fahrzeugtyp',
      brand: 'Marke',
      modelName: 'Model Name',
      series: 'Serie',
      vin: 'Fahrzeugidentifikationsnummer',
      chargingprofile: 'Ladeprofil',
      overrideTimer: 'Einmalige Abfahrtszeit',
      weekdays: 'Wochentag',
      departureTime: 'Abfahrtszeit',
      timerEnabled: 'Timer Aktiviert',
      preferredChargingWindow: 'Tägliches Ladefenster',
      endTime: 'Ende Uhrzeit',
      startTime: 'Start Uhrzeit',
      MONDAY: 'Montag',
      TUESDAY: 'Dienstag',
      WEDNESDAY: 'Mittwoch',
      THURSDAY: 'Donnerstag',
      FRIDAY: 'Freitag',
      SATURDAY: 'Samstag',
      SUNDAY: 'Sonntag',
      chargingMode: 'Lademodus',
      chargingPreferences: 'Ladeeinstellungen',
      climatizationEnabled: 'Klimatisierung Aktiviert',
      general: 'Allgemeine Fahrzeuginformationen',
      dealer: 'Händler',
      city: 'Stadt',
      country: 'Land',
      phone: 'Telefon',
      postalCode: 'Postleitzahl',
      street: 'Straße',
      supportedChargingModes: 'unterstützte Lademodi',
      accelerationValue: 'Beschleunigungs Wert',
      anticipationValue: 'Erwartungswert',
      auxiliaryConsumptionValue: 'Hilfsverbrauchswert',
      date: 'Datum',
      drivingModeValue: 'Fahrmodus',
      duration: 'Dauer',
      efficiencyValue: 'Effizienz Wert',
      electricDistance: 'elektrische Distanz',
      electricDistanceRatio: 'elektrisches Distanzverhältnis in %',
      savedFuel: 'Eingesparter Kraftstoff',
      totalConsumptionValue: 'Gesamtverbrauchswert',
      totalDistance: 'Gesamtstrecke',
      rangemap: 'Reichweitenkarte',
      center: 'Mitte',
      remote: 'Fernbedienung',
      CHARGE_NOW: 'jetzt Aufladen',
      CLIMATE_NOW: 'Klimatisierung starten',
      DOOR_LOCK: 'Autotüren zusperren',
      DOOR_UNLOCK: 'Autotüren aufsperren',
      GET_VEHICLES: 'Fahrzeuginformationen abrufen',
      GET_VEHICLE_STATUS: 'Fahrzeug Status abrufen',
      HORN_BLOW: 'Hupe einschalten',
      LIGHT_FLASH: 'Lichthupe einschalten',
      START_CHARGING: 'Laden starten',
      START_PRECONDITIONING: 'Startvoraussetzung',
      STOP_CHARGING: 'Laden stoppen',
      VEHICLE_FINDER: 'Positionsdaten Fahrzeug abrufen',
      serviceExecutionHistory: 'Verlauf der Remote-Ausführung',
      status: 'Aktueller Status',
      BRAKE_FLUID: 'Bremsflüssigkeit',
      cbsDescription: 'Service Beschreibung',
      cbsDueDate: 'Service Fälligkeitsdatum',
      cbsState: 'Service Status',
      cbsType: 'Service Art',
      VEHICLE_CHECK: 'Fahrzeug Überprüfung',
      position: 'Position',
      heading: 'Richtung',
      lat: 'Latitude',
      lon: 'Longitude',
      DCS_CCH_Activation: 'DCS CCH Aktivierung',
      DCS_CCH_Ongoing: 'DCS CHH Laufend',
      chargingConnectionType: 'Ladeverbindungstyp',
      chargingInductivePositioning: 'Aufladen Induktive Positionierung',
      chargingLevelHv: 'Batterie SoC in %',
      chargingStatus: 'Ladestatus',
      chargingTimeRemaining: 'Verbleibende Ladezeit',
      connectionStatus: 'Verbindungsstatus Ladestecker',
      doorDriverFront: 'Fahrertüren',
      driverFront: 'Fahrertüren',
      doorDriverRear: 'Hintere Türe Fahrerseite',
      doorLockState: 'Fahrzeug Verriegelungszustand Türen und Fenster',
      doorPassengerFront: 'Beifahrertüre',
      doorPassengerRear: 'Hintere Türe Beifahrerseite',
      hood: 'Motorhaube',
      internalDataTimeUTC: 'Fahrzeugzeit UTC',
      lastChargingEndReason: 'letzter Grund für das Ende des Ladevorgangs',
      lastChargingEndResult: 'letztes Ladeendergebnis',
      maxRangeElectric: 'max. elektrische Reichweite in km',
      maxRangeElectricMls: 'max. elektrische Reichweite in mi',
      mileage: 'Kilometerstand',
      remainingFuel: 'Tankinhalt',
      remainingRangeElectric: 'restliche Reichweite Elektrisch in km',
      remainingRangeElectricMls: 'restliche Reichweite Elektrisch in mi',
      remainingRangeFuel: 'restliche Reichweite Kraftstoff in km',
      remainingRangeFuelMls: 'restliche Reichweite Kraftstoff in mi',
      singleImmediateCharging: 'einmalige Sofortaufladung',
      trunk: 'Kofferraum',
      updateReason: 'Aktualisierungsgrund',
      updateTime: 'Aktualisierungszeit',
      vehicleCountry: 'Fahrzeug Land',
      windowDriverFront: 'Fenster Fahrerseite',
      windowPassengerFront: 'Fenster Beifahrerseite',
    };
    this.cookieJar = new tough.CookieJar(null, { ignoreError: true });

    this.requestClient = axios.create({
      withCredentials: true,
      httpsAgent: new HttpsCookieAgent({ cookies: { jar: this.cookieJar } }),
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
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }

    this.subscribeStates('*');
    if (!this.config.username || !this.config.password) {
      this.log.error('Please set username and password');
      return;
    }
    const sessionState = await this.getStateAsync('auth.session');
    if (sessionState?.val && typeof sessionState.val === 'string') {
      this.session = JSON.parse(sessionState.val);
      this.log.info('Session found. If the login fails please delete bmw.0.auth.session and restart the adapter');
      this.log.debug(JSON.stringify(this.session));
      await this.refreshToken();
    } else {
      if (!this.config.captcha) {
        this.log.error(`Please generate a captcha in the instance settings`);
        return;
      }

      await this.login();
    }
    if (this.config.musername && this.config.mpassword) {
      const msessionState = await this.getStateAsync(`auth.msession`);
      if (msessionState?.val && typeof msessionState.val === 'string') {
        this.msession = JSON.parse(msessionState.val);
        this.log.debug(JSON.stringify(this.msession));
        this.log.info(`Session found for M user. If the login fails please delete bmw.0.auth.msession and restart the adapter`);
        await this.refreshToken(true);
      } else {
        if (!this.config.captcha) {
          this.log.error(`Please generate a captcha in the instance settings to login the m user`);
          return;
        }
        this.log.info(`Start login for second user`);
        await this.login(true);
      }
    }

    if (this.session.access_token) {
      this.log.info(`Start getting ${this.config.brand} vehicles`);
      await this.getVehiclesv2(true);
      await this.cleanObjects();
      await this.sleep(5000);
      this.log.info(`Initial first update of the vehicles`);
      await this.updateDevices();
      this.log.info(`First update of Trips and Demands in 10 minutes`);
      this.setTimeout(
        async () => {
          this.log.info(`First update of Trips and Demands 10min after Adapter Start`);
          await this.updateDemands();
          await this.sleep(5000);
          await this.updateTrips();
        },
        1000 * 60 * 10,
      );
      this.updateInterval = setInterval(
        async () => {
          await this.sleep(2000);
          await this.updateDevices();
        },
        this.config.interval * 60 * 1000,
      );
      this.demandInterval = setInterval(
        async () => {
          await this.sleep(2000);
          await this.updateDemands();
          await this.sleep(5000);
          await this.updateTrips();
        },
        24 * 60 * 60 * 1000,
      );
      this.refreshTokenInterval = setInterval(
        async () => {
          await this.refreshToken();
          await this.sleep(5000);
          if (this.config.musername && this.config.mpassword) {
            await this.refreshToken(true);
          }
        },
        (this.session.expires_in - 123) * 1000,
      );
    }
  }
  async login(loginSecondUser) {
    let username = this.config.username;
    let password = this.config.password;
    if (loginSecondUser) {
      username = this.config.musername;
      password = this.config.mpassword;
    }
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'de-de',
      'Content-Type': 'application/x-www-form-urlencoded',
      hcaptchatoken: this.config.captcha,
    };
    const [code_verifier, codeChallenge] = this.getCodeChallenge();
    const data = {
      client_id: '31c357a0-7a1d-4590-aa99-33b97244d048',
      response_type: 'code',
      scope: 'openid profile email offline_access smacc vehicle_data perseus dlm svds cesim vsapi remote_services fupo authenticate_user',
      redirect_uri: 'com.bmw.connected://oauth',
      state: 'cwU-gIE27j67poy2UcL3KQ',
      nonce: 'login_nonce',
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
      username: username,
      password: password,
      grant_type: 'authorization_code',
    };

    const authUrl = await this.requestClient({
      method: 'post',
      url: `https://customer.bmwgroup.com/gcdm/oauth/authenticate`,
      headers: headers,
      data: qs.stringify(data),
      withCredentials: true,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch(async (error) => {
        this.log.error('Login failed');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        if (error.response && error.response.status === 401) {
          this.log.error('Please check username and password or generate a new captcha in the instance settings');
          this.log.error('Please wait 5 minutes before trying again');
          this.log.error('Start relogin in 5min');

          this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
          this.reLoginTimeout = setTimeout(
            async () => {
              //get adapter settings and set captcha to null
              const adapterSettings = await this.getForeignObjectAsync('system.adapter.' + this.namespace);
              if (adapterSettings && adapterSettings.native) {
                adapterSettings.native.captcha = null;
                await this.setForeignObjectAsync('system.adapter.' + this.namespace, adapterSettings);
              }
            },
            5000 * 60 * 1,
          );
        }
        if (error.response && error.response.status === 400) {
          this.log.error('Please check username and password');
        }
        if (error.response && error.response.status === 429) {
          this.log.error('Login Rate Limit exceeded, please wait 5 minutes');
        }
      });
    if (!authUrl || !authUrl.redirect_to) {
      this.log.error(JSON.stringify(authUrl));
      return;
    }

    delete data.username;
    delete data.password;
    delete data.grant_type;
    data.authorization = qs.parse(authUrl.redirect_to).authorization;
    const code = await this.requestClient({
      method: 'post',
      url: 'https://customer.bmwgroup.com/gcdm/oauth/authenticate',
      headers: headers,
      data: qs.stringify(data),
      withCredentials: true,
      maxRedirects: 0,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        let code = '';
        if (error.response && error.response.status >= 400) {
          this.log.error(JSON.stringify(error.response.data));
          return;
        }
        if (error.response && error.response.status === 302) {
          this.log.debug(JSON.stringify(error.response.headers.location));
          code = String(qs.parse(error.response.headers.location.split('?')[1]).code);
          this.log.debug(code);
          return code;
        }
        this.log.error(error);
        return;
      });
    await this.requestClient({
      method: 'post',
      url: 'https://customer.bmwgroup.com/gcdm/oauth/token',
      withCredentials: true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': this.userAgent,
        Accept: '*/*',
        'Accept-Language': 'de-de',
        Authorization: 'Basic MzFjMzU3YTAtN2ExZC00NTkwLWFhOTktMzNiOTcyNDRkMDQ4OmMwZTMzOTNkLTcwYTItNGY2Zi05ZDNjLTg1MzBhZjY0ZDU1Mg==',
      },
      data: `code=${code}&redirect_uri=com.bmw.connected://oauth&grant_type=authorization_code&code_verifier=${code_verifier}`,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));

        await this.extendObject('auth', {
          type: 'channel',
          common: {
            name: 'Authentification Information',
          },
          native: {},
        });
        await this.extendObject('auth.session', {
          type: 'state',
          common: {
            name: 'Session Token',
            type: 'string',
            role: 'value',
            read: true,
            write: false,
          },
          native: {},
        });
        if (loginSecondUser) {
          this.msession = res.data;
          await this.extendObject('auth.msession', {
            type: 'state',
            common: {
              name: 'MSession Token',
              type: 'string',
              role: 'value',
              read: true,
              write: false,
            },
            native: {},
          });
          await this.setState('auth.msession', JSON.stringify(this.msession), true);
        } else {
          this.session = res.data;
        }
        this.setState('auth.session', JSON.stringify(this.session), true);
        this.setState('info.connection', true, true);
        return res.data;
      })
      .catch((error) => {
        this.log.error('Login step 3 failed');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  getCodeChallenge() {
    let hash = '';
    let result = '';
    const chars = '0123456789abcdef';
    result = '';
    for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    hash = crypto.createHash('sha256').update(result).digest('base64');
    hash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    return [result, hash];
  }

  async getVehiclesv2(firstStart) {
    const brand = this.config.brand;
    const headers = {
      'user-agent': this.userAgentDart,
      'x-user-agent': this.xuserAgent.replace(';brand;', `;${brand};`),
      authorization: 'Bearer ' + this.session.access_token,
      'accept-language': 'de-DE',
      host: 'cocoapi.bmwgroup.com',
      '24-hour-format': 'true',
    };
    this.log.debug('getVehiclesv2');
    await this.requestClient({
      method: 'get',
      url: `https://cocoapi.bmwgroup.com/eadrax-vcs/v4/vehicles?apptimezone=120&appDateTime=${Date.now()}&tireGuardMode=ENABLED`,
      headers: headers,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (firstStart) {
          this.log.info(`Found ${res.data.length} ${brand} vehicles`);
        }
        if (res.data.length === 0) {
          this.log.info(`No ${brand} vehicles found please check brand in instance settings`);
          return;
        }
        for (const vehicle of res.data) {
          if (this.config.ignorelist) {
            this.log.info('Ignorelist found');
            const ignoreListArray = this.config.ignorelist.replace(/\s/g, '').split(',');
            if (ignoreListArray.includes(vehicle.vin)) {
              this.log.info('Ignore ' + vehicle.vin);
              continue;
            }
          }
          this.vinArray.push(vehicle.vin);
          let vehicleName = vehicle.model;
          if (!vehicleName && vehicle.attributes) {
            vehicleName = vehicle.attributes.model;
          }
          await this.extendObject(vehicle.vin, {
            type: 'device',
            common: {
              name: vehicleName,
            },
            native: {},
          });
          await this.extendObject(vehicle.vin + '.state', {
            type: 'channel',
            common: {
              name: 'Current status of the car v4',
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(vehicle.vin + '.remotev2', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });

          const remoteArray = [
            { command: 'door-lock', name: 'Lock Doors (Not updated)' },
            { command: 'door-unlock', name: 'Unlock Doors (Not updated)' },
            { command: 'door', name: 'Door Lock True=Lock, False=Unlock' },
            { command: 'horn-blow', name: 'Horn Blow' },
            { command: 'light-flash', name: 'Light Flash' },
            { command: 'vehicle-finder', name: 'Trigger Vehicle Finder' },
            { command: 'climate-now_START', name: 'Start Climate (Not updated)' },
            { command: 'climate-now_STOP', name: 'Stop Climate (Not updated)' },
            { command: 'climate-now', name: 'Climate True=Start, False=Stop' },
            { command: 'start-charging', name: 'Start Charging (Not updated)' },
            { command: 'stop-charging', name: 'Stop Charging (Not updated)' },
            { command: 'charging', name: 'Charging True=Start, False=Stop' },
            { command: 'force-refresh', name: 'Force Refresh' },
            { command: 'fetch-images', name: 'Fetch Images of the car in the image folder' },
            {
              command: 'fetch-charges',
              name: 'Fetch Charge Sessions/Statistics for month',
              type: 'string',
              role: 'text',
              def: '2024-06',
            },
          ];
          remoteArray.forEach((remote) => {
            this.extendObject(`${vehicle.vin}.remotev2.${remote.command}`, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
                def: remote.def == null ? false : remote.def,
                write: true,
                read: true,
              },
              native: {},
            });
          });

          this.json2iob.parse(vehicle.vin, vehicle, {
            forceIndex: true,
            descriptions: this.description,
            channelName: vehicleName,
          });
        }
      })
      .catch((error) => {
        this.log.error('getvehicles v2 failed');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        if (error.response && (error.response.status === 403 || error.response.status === 429)) {
          this.log.warn('Rate Limit exceeded, please wait 5 minutes');
        }
        this.log.info('Adapter will retry in 3 minutes to get vehicles');
        this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
        this.reLoginTimeout = setTimeout(
          () => {
            this.getVehiclesv2();
          },
          1000 * 60 * 3,
        );
      });
    await this.sleep(5000);
  }
  async updateDevices() {
    const brand = this.config.brand;
    const headers = {
      'user-agent': this.userAgentDart,
      'x-user-agent': this.xuserAgent.replace(`;brand;`, `;${brand};`),
      authorization: 'Bearer ' + this.session.access_token,
      'accept-language': 'de-DE',
      host: 'cocoapi.bmwgroup.com',
      '24-hour-format': 'true',
    };
    for (const vin of this.vinArray) {
      this.log.debug('update ' + vin);
      headers['bmw-vin'] = vin;
      await this.requestClient({
        method: 'get',
        url: `https://cocoapi.bmwgroup.com/eadrax-vcs/v4/vehicles/state?apptimezone=120&appDateTime=${Date.now()}&tireGuardMode=ENABLED`,
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          if (res.data.state && res.data.state.electricChargingState && !res.data.state.electricChargingState.remainingChargingMinutes) {
            res.data.state.electricChargingState.remainingChargingMinutes = 0;
          }
          this.json2iob.parse(vin, res.data, { forceIndex: true, descriptions: this.description });
          await this.extendObject(`${vin}.state.rawJSON`, {
            type: 'state',
            common: {
              name: 'Raw Data as JSON',
              type: 'string',
              role: 'json',
              write: false,
              read: true,
            },
            native: {},
          });
          this.setState(`${vin}.state.rawJSON`, JSON.stringify(res.data), true);
        })
        .catch(async (error) => {
          if (error.response && error.response.status === 429) {
            this.log.debug(`${error.response.data.message} - Retry in 5 seconds`);
            await this.sleep(5000);
            await this.updateDevices();
            return;
          }
          if (error.response && error.response.status === 403) {
            this.log.warn(error.response.data.message);
            return;
          }
          if (error.response && error.response.status >= 500) {
            this.log.error('BMW server is not available');
          }
          this.log.error('update failed');
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
      await this.updateChargingSessionv2(vin);
      await this.sleep(10000);
    }
  }
  async updateDemands() {
    const brand = this.config.brand;
    const headers = {
      'user-agent': this.userAgentDart,
      'x-user-agent': this.xuserAgent.replace(';brand;', `;${brand};`),
      authorization: 'Bearer ' + this.session.access_token,
      'accept-language': 'de-DE',
      host: 'cocoapi.bmwgroup.com',
      '24-hour-format': 'true',
    };
    for (const vin of this.vinArray) {
      this.log.debug(`update demands ${vin}`);
      headers['bmw-vin'] = vin;
      await this.requestClient({
        method: 'get',
        url: 'https://cocoapi.bmwgroup.com/eadrax-slcs/v1/demands',
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          await this.json2iob.parse(`${vin}.servicedemands`, res.data, {
            channelName: 'Service Demands',
            forceIndex: true,
            descriptions: this.description,
            deleteBeforeUpdate: true,
          });
          await this.setObjectNotExistsAsync(`${vin}.servicedemands.json`, {
            type: 'state',
            common: {
              name: 'Service Demands JSON',
              type: 'string',
              role: 'json',
              write: false,
              read: true,
            },
            native: {},
          });
          await this.setState(`${vin}.servicedemands.json`, JSON.stringify(res.data), true);
        })
        .catch(async (error) => {
          if (error.response && error.response.status === 429) {
            this.log.debug(`${error.response.data.message} Retry in 15 minutes`);
            await this.sleep(1000 * 60 * 15);
            await this.updateDemands();
            return;
          }
          if (error.response && error.response.status === 403) {
            this.log.warn(error.response.data.message);
            return;
          }
          if (error.response && error.response.status >= 500) {
            this.log.error('BMW server is not available');
          }
          this.log.error('update demand failed');
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
      await this.sleep(10000);
    }
  }
  async updateTrips() {
    const brand = this.config.brand;
    const headers = {
      'user-agent': this.userAgentDart,
      'x-user-agent': this.xuserAgent.replace(`;brand;`, `;${brand};`),
      authorization: 'Bearer ' + this.session.access_token,
      'accept-language': 'de-DE',
      host: 'cocoapi.bmwgroup.com',
      '24-hour-format': 'true',
      'x-gcid': this.session.gcid,
    };
    for (const vin of this.vinArray) {
      this.log.debug(`update trips ${vin}`);
      headers['bmw-vin'] = vin;
      await this.requestClient({
        method: 'get',
        url: `https://cocoapi.bmwgroup.com/eadrax-suscs/v1/vehicles/sustainability/widget`,
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          await this.json2iob.parse(`${vin}.trips`, res.data, {
            channelName: 'Trip History',
            forceIndex: true,
            descriptions: this.description,
          });
          await this.setObjectNotExistsAsync(`${vin}.trips.json`, {
            type: 'state',
            common: {
              name: 'Trip History JSON',
              type: 'string',
              role: 'json',
              write: false,
              read: true,
            },
            native: {},
          });
          await this.setStateAsync(`${vin}.trips.json`, JSON.stringify(res.data), true);
        })
        .catch(async (error) => {
          if (error.response && error.response.status === 429) {
            this.log.debug(`${error.response.data.message} Retry in 15 minutes`);
            await this.sleep(1000 * 60 * 15);
            await this.updateTrips();
            return;
          }
          if (error.response && error.response.status === 403) {
            this.log.warn(error.response.data.message);
            return;
          }
          if (error.response && error.response.status >= 500) {
            this.log.error('BMW Server is not available');
          }
          this.log.error('update trip failed');
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
      await this.sleep(10000);
    }
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async updateChargingSessionv2(vin, maxResults = 40, dateInput) {
    if (this.nonChargingHistory[vin]) {
      return;
    }
    if (Date.now() - this.lastChargingSessionUpdate < 1000 * 60 * 60 * 6 && !dateInput) {
      this.log.debug(`updateChargingSessionv2 to early ${vin}`);
      return;
    }
    await this.sleep(10000);
    this.lastChargingSessionUpdate = Date.now();
    const headers = {
      'user-agent': this.userAgentDart,
      'x-user-agent': this.xuserAgent.replace(`;brand;`, `;${this.config.brand};`),
      authorization: 'Bearer ' + this.session.access_token,
      'accept-language': 'de-DE',
      '24-hour-format': 'true',
      'bmw-vin': vin,
    };

    const d = new Date();
    let dateFormatted =
      `${d.getFullYear().toString()}-` +
      ((d.getMonth() + 1).toString().length == 2 ? (d.getMonth() + 1).toString() : '0' + (d.getMonth() + 1).toString());
    // const day = d.getDate().toString().length == 2 ? d.getDate().toString() : "0" + d.getDate().toString();
    let fullDate = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().replace('Z', '000');

    if (dateInput) {
      dateFormatted = dateInput;
      const tempDate = new Date(`${dateInput}-01T00:00:00.000Z`);
      fullDate = new Date(tempDate.getTime() - tempDate.getTimezoneOffset() * 60000).toISOString().replace('Z', '000');
    }
    const urlArray = [];
    if (this.config.fetchChargeSessions) {
      urlArray.push({
        url:
          `https://cocoapi.bmwgroup.com/eadrax-chs/v2/charging-sessions?vin=${vin}` +
          `&next_token&date=${dateFormatted}` +
          `-01T00%3A00%3A00.000Z&maxResults=${maxResults}` +
          `&include_date_picker=false`,
        path: '.chargingSessions.',
        name: 'chargingSessions',
      });
    }
    if (this.config.fetchChargeStats) {
      urlArray.push({
        url: `https://cocoapi.bmwgroup.com/eadrax-chs/v2/charging-statistics?vin=${vin}&currentDate=${fullDate}`,
        path: '.charging-statistics.',
        name: 'charging statistics',
      });
    }
    for (const element of urlArray) {
      await this.sleep(10000);
      this.log.debug(`update ${vin}${element.path}`);
      await this.requestClient({
        method: 'get',
        url: element.url,
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          let data = res.data;
          if (data.chargingSessions) {
            data = data.chargingSessions;
          }
          await this.extendObject(vin + element.path + dateFormatted, {
            type: 'channel',
            common: {
              name: `${element.name} of the car v2`,
            },
            native: {},
          });
          if (element.name === 'chargingSessions' && data.sessions?.length > 0) {
            data.totalEnergy = data.total.replace('~', '').trim().split(' ')[0];
            data.totalUnit = data.total.replace('~', '').trim().split(' ')[1];
            data.totalCost = [];
            for (const current of data.costsGroupedByCurrency) {
              data.totalCost.push(current.replace('~', '').trim().split(' ')[0]);
            }
            const newSessions = [];
            for (const session of data.sessions) {
              try {
                session.date = session.id.split('_')[0];
                session.id = session.id.split('_')[1] ? session.id.split('_')[1] : session.id;
                session.timestamp = new Date(session.date).valueOf();
                if (session.energyCharged.replace) {
                  session.energy = session.energyCharged.replace('~', '').replace('<', '').trim().split(' ')[0];
                  session.unit = session.energyCharged.replace('~', '').replace('<', '').trim().split(' ')[1];
                }
                if (session.subtitle.replace) {
                  //subtitle = Zuhause • 2h 16min • ~ 5,97 EUR
                  //remove all tildes
                  let cleanedSubtitle = session.subtitle.replace(/~/g, '');
                  //remove all small than
                  cleanedSubtitle = cleanedSubtitle.replace(/</g, '');
                  //split array on dots
                  cleanedSubtitle = cleanedSubtitle.split('•');
                  // const cleanedSubtitle = session.subtitle.replace('~', '').replace('•', '').replace('  ', ' ').replace('  ', ' ').trim();
                  session.location = cleanedSubtitle[0].trim();
                  session.duration = cleanedSubtitle[1].trim();
                  session.cost = cleanedSubtitle[2].trim().split(' ')[0];
                  session.currency = cleanedSubtitle[2].trim().split(' ')[1];
                }
                newSessions.push(session);
              } catch (error) {
                this.log.debug(error);
              }
            }
            data.sessions = newSessions;
            await this.extendObject(`${vin}${element.path}${dateFormatted}.raw`, {
              type: 'state',
              common: {
                name: 'Raw Data as JSON',
                type: 'string',
                role: 'json',
                write: false,
                read: true,
              },
              native: {},
            });
            await this.setState(`${vin}${element.path}${dateFormatted}.raw`, JSON.stringify(data), true);
            await this.json2iob.parse(`${vin}${element.path}${dateFormatted}`, data, { preferedArrayName: 'date' });
            try {
              const datal = data.sessions[0];
              datal._date = datal.id.split('_')[0];
              datal._id = datal.id.split('_')[1];
              datal.timestamp = new Date(datal._date).valueOf();
              if (datal.energyCharged.replace) {
                datal.energy = datal.energyCharged.replace('~', '').trim().split(' ')[0];
                datal.unit = datal.energyCharged.replace('~', '').trim().split(' ')[1];
              }
              datal.id = 'latest';
              await this.setObjectNotExistsAsync(vin + element.path + 'latest', {
                type: 'channel',
                common: {
                  name: `${element.name}latest of the car v2`,
                },
                native: {},
              });
              await this.json2iob.parse(`${vin}${element.path}latest`, datal);
            } catch (error) {
              this.log.debug(error);
            }
          }
        })
        .catch((error) => {
          if (error.response && error.response.status === 403) {
            this.log.debug(`${error.response.data.message} Retry in 5 seconds`);
            return;
          }
          if (error.response) {
            this.log.info(`No charging session available. Ignore ${vin} until restart`);
            this.nonChargingHistory[vin] = true;
            this.log.debug(error);
            error.response && this.log.debug(JSON.stringify(error.response.data));
            return;
          }
          this.log.error(`updateChargingSessionv2 failed`);
          this.log.error(element.url);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }

  async cleanObjects() {
    for (const vin of this.vinArray) {
      const remoteState = await this.getObjectAsync(`${vin}.properties`);

      if (remoteState) {
        this.log.debug(`clean old states ${vin}`);
        await this.delObjectAsync(`${vin}.statusv1`, { recursive: true });
        await this.delObjectAsync(`${vin}.lastTrip`, { recursive: true });
        await this.delObjectAsync(`${vin}.allTrips`, { recursive: true });
        await this.delObjectAsync(`${vin}.status`, { recursive: true });
        await this.delObjectAsync(`${vin}.properties`, { recursive: true });
        await this.delObjectAsync(`${vin}.capabilities`, { recursive: true });
        await this.delObjectAsync(`${vin}.chargingprofile`, { recursive: true });
        await this.delObjectAsync(`${vin}.serviceExecutionHistory`, { recursive: true });
        await this.delObjectAsync(`${vin}.apiV2`, { recursive: true });
        await this.delObject(`${vin}.remote`, { recursive: true });
        await this.delObject(`_DatenNeuLaden`);
        await this.delObject(`_LetzterDatenabrufOK`);
        await this.delObject(`_LetzerFehler`);
      }
    }
  }
  getDate() {
    const d = new Date();

    const date_format_str =
      d.getFullYear().toString() +
      '-' +
      ((d.getMonth() + 1).toString().length == 2 ? (d.getMonth() + 1).toString() : '0' + (d.getMonth() + 1).toString()) +
      '-' +
      (d.getDate().toString().length == 2 ? d.getDate().toString() : '0' + d.getDate().toString()) +
      'T' +
      (d.getHours().toString().length == 2 ? d.getHours().toString() : '0' + d.getHours().toString()) +
      ':' +
      (d.getMinutes().toString().length == 2 ? d.getMinutes().toString() : '0' + d.getMinutes().toString()) +
      ':00';
    return date_format_str;
  }
  async fetchImages(vin) {
    const viewsArray = [
      'FrontView',
      'RearView',
      'FrontLeft',
      'FrontRight',
      'RearLeft',
      'RearRight',
      'SideViewLeft',
      'Dashboard',
      'DriverDoor',
      'RearView',
    ];
    const headers = {
      'user-agent': this.userAgentDart,
      'x-user-agent': this.xuserAgent.replace(`;brand;`, `;${this.config.brand};`),
      authorization: 'Bearer ' + this.session.access_token,
      'accept-language': 'de-DE',
      '24-hour-format': 'true',
      'bmw-vin': vin,
      accept: 'image/png',
      'bmw-app-vehicle-type': 'connected',
    };
    for (const view of viewsArray) {
      this.log.info(`Fetch image from ${view} to bmw.0.${vin}.images.${view}`);
      await this.requestClient({
        method: 'get',
        url: `https://cocoapi.bmwgroup.com/eadrax-ics/v5/presentation/vehicles/images`,
        params: {
          carView: view,
          toCrop: true,
        },
        headers: headers,
        responseType: 'arraybuffer',
      })
        .then(async (res) => {
          //save base64 image to state
          const base64 = Buffer.from(res.data, 'binary').toString('base64');
          await this.setObjectNotExistsAsync(`${vin}.images.${view}`, {
            type: 'state',
            common: {
              name: view,
              type: 'string',
              role: 'state',
              read: true,
              write: false,
            },
            native: {},
          });
          await this.setState(`${vin}.images.${view}`, `data:image/png;base64,${base64}`, true);
        })
        .catch((error) => {
          this.log.error(`fetch images failed ${view}`);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
      await this.sleep(5000);
    }
  }
  async refreshToken(useSecondUser) {
    this.log.debug(`refresh token`);
    let refresh_token = this.session.refresh_token;
    if (useSecondUser) {
      refresh_token = this.msession.refresh_token;
    }
    await this.requestClient({
      method: 'post',
      url: `https://customer.bmwgroup.com/gcdm/oauth/token`,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: '*/*',
        Authorization: `Basic MzFjMzU3YTAtN2ExZC00NTkwLWFhOTktMzNiOTcyNDRkMDQ4OmMwZTMzOTNkLTcwYTItNGY2Zi05ZDNjLTg1MzBhZjY0ZDU1Mg==`,
      },
      data: `redirect_uri=com.bmw.connected://oauth&refresh_token=${refresh_token}&grant_type=refresh_token`,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (useSecondUser) {
          this.msession = res.data;

          this.setState(`auth.msession`, JSON.stringify(this.msession), true);
        } else {
          this.session = res.data;
        }

        this.setState(`auth.session`, JSON.stringify(this.session), true);
        this.setState(`info.connection`, true, true);
        return res.data;
      })
      .catch((error) => {
        this.log.error('Refresh token failed. Please delete the Object DP "bmw.0.auth.session" and restart the adapter');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error(`Start relogin in 1min`);
        this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
        this.reLoginTimeout = setTimeout(
          () => {
            this.login();
          },
          1000 * 60 * 1,
        );
      });
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  async onUnload(callback) {
    try {
      clearTimeout(this.refreshTimeout);
      clearTimeout(this.reLoginTimeout);
      clearInterval(this.updateInterval);
      clearInterval(this.refreshTokenInterval);
      this.demandInterval && clearInterval(this.demandInterval);
      //get adapter settings and set captcha to null
      if (this.config.captcha) {
        const adapterSettings = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        if (adapterSettings && adapterSettings.native) {
          adapterSettings.native.captcha = null;
          await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, adapterSettings);
        }
      }
      callback();
    } catch (e) {
      this.log.error(e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        if (id.indexOf('.remotev2.') === -1) {
          this.log.warn(`Please use remotev2 to control`);
          return;
        }

        const vin = id.split('.')[2];

        let command = id.split('.')[4];
        if (command === 'force-refresh') {
          this.log.info('force refresh');
          this.updateDevices();
          return;
        }
        if (command === 'fetch-images') {
          this.log.info('fetch images');
          await this.fetchImages(vin);
          return;
        }
        if (command === 'fetch-charges') {
          this.log.info('fetch charges');
          await this.updateChargingSessionv2(vin, 200, state.val);
          return;
        }
        if (command === 'charging') {
          command = 'start-charging';
          if (!state.val) {
            command = 'stop-charging';
          }
        }
        if (command === 'climate-now') {
          command = 'climate-now_START';
          if (!state.val) {
            command = 'climate-now_STOP';
          }
        }
        if (command === 'door') {
          command = 'door-lock';
          if (!state.val) {
            command = 'door-unlock';
          }
        }
        const action = command.split('_')[1];
        command = command.split('_')[0];
        let access_token = this.session.access_token;
        if (this.msession) {
          this.log.debug('Use second user for remote command');
          access_token = this.msession.access_token;
        }
        const headers = {
          'user-agent': this.userAgentDart,
          'x-user-agent': this.xuserAgent.replace(`;brand;`, `;${this.config.brand};`),
          authorization: 'Bearer ' + access_token,
          'accept-language': 'de-DE',
          host: 'cocoapi.bmwgroup.com',
          '24-hour-format': 'true',
          'Content-Type': 'text/plain',
          'bmw-vin': vin,
        };
        const url = `https://cocoapi.bmwgroup.com/eadrax-vrccs/v4/presentation/remote-commands/${command}${action ? `?action=${action}` : ''}`;

        this.log.debug(`Send remote command ${command} to ${vin}`);
        await this.requestClient({
          method: 'post',
          url: url,
          headers: headers,
          'axios-retry': {
            retries: 5,
            // only 403 rate limit
            retryCondition: (error) => {
              this.log.debug(error);
              error.response && this.log.debug(JSON.stringify(error.response.data));
              return error.response && error.response.status === 403;
            },
            onRetry: (retryCount, error) => {
              this.log.info(`Retry ${retryCount}`);
              this.log.debug(error);
              error.response && this.log.info(JSON.stringify(error.response.data));
              this.log.warn(`Rate Limit exceeded, retry in 5 seconds`);
            },
            onMaxRetryTimesExceeded: () => {
              this.log.error(`3 Retries failed`);
            },
          },
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            const eventId = res.data.eventId;
            this.log.debug(`Check Status of event in 10sec`);
            this.setTimeout(() => {
              this.checkEventStatus(eventId, headers).then(async (res) => {
                if (res === 'EXECUTED') {
                  this.log.info(`Remote command executed`);
                } else {
                  this.log.info(`Remote event is not finished it is: ${res}`);
                  await this.sleep(10000);
                  this.checkEventStatus(eventId, headers).then((res) => {
                    if (res === 'EXECUTED') {
                      this.log.info(`Remote command executed`);
                    } else if (res === 'RUNNING') {
                      this.log.info(`Remote command is still running`);
                    } else if (res === 'UNKNOWN') {
                      this.log.debug(`Remote command is unknown`);
                    } else {
                      this.log.warn(`Remote command failed ${res}`);
                    }
                  });
                }
              });
            }, 10 * 1000);

            return res.data;
          })
          .catch((error) => {
            this.log.error(`Remote command failed`);

            this.log.error(error);
            if (error.response) {
              //check for 403 quota exceeded
              if (error.response.status === 403) {
                this.log.warn(
                  `Rate Limit exceeded, think about to use the second user Mitbenutzer feature in the adapter settings to send remote commands`,
                );
              }
              this.log.error(JSON.stringify(error.response.data));
            }
          });
        this.refreshTimeout = setTimeout(async () => {
          this.log.info('Refresh values');
          await this.updateDevices();
        }, 12 * 1000);
      } else {
        const resultDict = { chargingStatus: 'charging', combinedSecurityState: 'door', activity: 'climate-now' };
        const idArray = id.split('.');
        const stateName = idArray[idArray.length - 1];
        const vin = id.split('.')[2];
        if (resultDict[stateName]) {
          let value = true;
          if (
            !state.val ||
            state.val === 'INVALID' ||
            state.val === 'INACTIVE' ||
            state.val === 'NOT_CHARGING' ||
            state.val === 'ERROR' ||
            state.val === 'UNLOCKED'
          ) {
            value = false;
          }
          await this.setState(`${vin}.remotev2.${resultDict[stateName]}`, value, true);
        }

        // if (id.indexOf('.chargingStatus') !== -1 && state.val !== 'CHARGING') {
        //   await this.setObjectNotExistsAsync(vin + '.status.chargingTimeRemaining', {
        //     type: 'state',
        //     common: {
        //       name: 'chargingTimeRemaining',
        //       role: 'value',
        //       type: 'number',
        //       write: false,
        //       read: true,
        //     },
        //     native: {},
        //   });
        //   this.setState(vin + '.status.chargingTimeRemaining', 0, true);
        // }
      }
    }
  }

  async checkEventStatus(eventId, headers) {
    try {
      const res = await this.requestClient({
        method: 'post',
        url: `https://cocoapi.bmwgroup.com/eadrax-vrccs/v4/presentation/remote-commands/eventStatus?eventId=${eventId}`,
        headers: headers,
      });
      this.log.debug(JSON.stringify(res.data));
      return res.data.rsEventStatus;
    } catch (error) {
      this.log.info(`Cannot Fetch the status of the sent command. Status is Unknown`);
      this.log.info(error);
      if (error.response) {
        this.log.info(JSON.stringify(error.response.data));
        if (error.response.status === 403) {
          return 'UNKNOWN';
        }
      }
      return 'Failed';
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Bmw(options);
} else {
  // otherwise start the instance directly
  new Bmw();
}
