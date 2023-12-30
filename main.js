'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;

const { HttpsCookieAgent } = require('http-cookie-agent/http');
const crypto = require('crypto');
const qs = require('qs');
const Json2iob = require('json2iob');
const tough = require('tough-cookie');
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
    this.userAgentDart = 'Dart/2.14 (dart:io)';
    this.xuserAgent = 'android(SP1A.210812.016.C1);brand;99.0.0(99999);row';
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
    await this.login();
    if (this.session.access_token) {
      this.log.info(`Start getting ${this.config.brand} vehicles`);
      await this.getVehiclesv2(true);
      await this.cleanObjects();
      await this.updateDevices();
      this.updateInterval = setInterval(
        async () => {
          await this.sleep(2000);
          await this.updateDevices();
        },
        this.config.interval * 60 * 1000,
      );
      this.refreshTokenInterval = setInterval(
        async () => {
          await this.refreshToken();
          await this.sleep(5000);
        },
        (this.session.expires_in - 123) * 1000,
      );
    }
  }
  async login() {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'de-de',
      'Content-Type': 'application/x-www-form-urlencoded',
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
      username: this.config.username,
      password: this.config.password,
      grant_type: 'authorization_code',
    };

    const authUrl = await this.requestClient({
      method: 'post',
      url: 'https://customer.bmwgroup.com/gcdm/oauth/authenticate',
      headers: headers,
      data: qs.stringify(data),
      withCredentials: true,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.error('Login failed');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        if (error.response && error.response.status === 401) {
          this.log.error('Please check username and password or too many logins in 5 minutes');

          this.log.error('Start relogin in 5min');
          this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
          this.reLoginTimeout = setTimeout(
            () => {
              this.login();
            },
            5000 * 60 * 1,
          );
        }
        if (error.response && error.response.status === 400) {
          this.log.error('Please check username and password');
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
          code = qs.parse(error.response.headers.location.split('?')[1]).code;
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
      data: 'code=' + code + '&redirect_uri=com.bmw.connected://oauth&grant_type=authorization_code&code_verifier=' + code_verifier,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
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
      url: 'https://cocoapi.bmwgroup.com/eadrax-vcs/v4/vehicles?apptimezone=120&appDateTime=' + Date.now() + '&tireGuardMode=ENABLED',
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
          this.vinArray.push(vehicle.vin);
          await this.extendObjectAsync(vehicle.vin, {
            type: 'device',
            common: {
              name: vehicle.model || vehicle.attributes?.model,
            },
            native: {},
          });
          await this.extendObjectAsync(vehicle.vin + '.state', {
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
            { command: 'door-lock' },
            { command: 'door-unlock' },
            { command: 'horn-blow' },
            { command: 'light-flash' },
            { command: 'vehicle-finder' },
            { command: 'climate-now_START' },
            { command: 'climate-now_STOP' },
            { command: 'start-charging' },
            { command: 'stop-charging' },
            { command: 'force-refresh', name: 'Force Refresh' },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(vehicle.vin + '.remotev2.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
                write: true,
                read: true,
              },
              native: {},
            });
          });
          this.json2iob.parse(vehicle.vin, vehicle, {
            forceIndex: true,
            descriptions: this.description,
          });

          await this.updateChargingSessionv2(vehicle.vin);
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
      'x-user-agent': this.xuserAgent.replace(';brand;', `;${brand};`),
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
        url:
          'https://cocoapi.bmwgroup.com/eadrax-vcs/v4/vehicles/state?apptimezone=120&appDateTime=' + Date.now() + '&tireGuardMode=ENABLED',
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          this.json2iob.parse(vin, res.data, { forceIndex: true, descriptions: this.description });
        })
        .catch(async (error) => {
          if (error.response && error.response.status === 429) {
            this.log.debug(error.response.data.message + ' Retry in 5 seconds');
            await this.sleep(5000);
            await this.updateDevices();
            return;
          }
          if (error.response && error.response.status === 403) {
            this.log.warn(error.response.data.message);
            return;
          }
          if (error.response && error.response.status >= 500) {
            this.log.error('BMW Server is not available');
          }
          this.log.error('update failed');
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
      await this.updateChargingSessionv2(vin);
      await this.sleep(10000);
    }
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async updateChargingSessionv2(vin) {
    if (this.nonChargingHistory[vin]) {
      return;
    }
    if (Date.now() - this.lastChargingSessionUpdate < 1000 * 60 * 60 * 6) {
      this.log.debug('updateChargingSessionv2 to early ' + vin);
      return;
    }
    await this.sleep(10000);
    this.lastChargingSessionUpdate = Date.now();
    const headers = {
      'user-agent': this.userAgentDart,
      'x-user-agent': this.xuserAgent.replace(';brand;', `;${this.config.brand};`),
      authorization: 'Bearer ' + this.session.access_token,
      'accept-language': 'de-DE',
      '24-hour-format': 'true',
    };
    const d = new Date();
    const dateFormatted =
      d.getFullYear().toString() +
      '-' +
      ((d.getMonth() + 1).toString().length == 2 ? (d.getMonth() + 1).toString() : '0' + (d.getMonth() + 1).toString());
    // const day = d.getDate().toString().length == 2 ? d.getDate().toString() : "0" + d.getDate().toString();
    const fullDate = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().replace('Z', '000');

    const urlArray = [];
    urlArray.push({
      url:
        'https://cocoapi.bmwgroup.com/eadrax-chs/v1/charging-sessions?vin=' +
        vin +
        '&next_token&date=' +
        dateFormatted +
        '-01T00%3A00%3A00.000Z&maxResults=40&include_date_picker=true',
      path: '.chargingSessions.',
      name: 'chargingSessions',
    });

    urlArray.push({
      url: 'https://cocoapi.bmwgroup.com/eadrax-chs/v1/charging-statistics?vin=' + vin + '&currentDate=' + fullDate,
      path: '.charging-statistics.',
      name: 'charging statistics',
    });
    for (const element of urlArray) {
      await this.sleep(10000);
      this.log.debug('update ' + vin + element.path);
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
          await this.setObjectNotExistsAsync(vin + element.path + dateFormatted, {
            type: 'channel',
            common: {
              name: element.name + ' of the car v2',
            },
            native: {},
          });
          if (element.name === 'chargingSessions' && data.sessions && data.sessions.length > 0) {
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
                  session.energy = session.energyCharged.replace('~', '').trim().split(' ')[0];
                  session.unit = session.energyCharged.replace('~', '').trim().split(' ')[1];
                }
                if (session.subtitle.replace) {
                  const cleanedSubtitle = session.subtitle.replace('~', '').replace('•', '').replace('  ', ' ').replace('  ', ' ').trim();
                  session.duration = cleanedSubtitle.split(' ')[1];
                  session.cost = cleanedSubtitle.split(' ')[2];
                }
                newSessions.push(session);
              } catch (error) {
                this.log.debug(error);
              }
            }
            data.sessions = newSessions;
            await this.json2iob.parse(vin + element.path + dateFormatted, data, { preferedArrayName: 'date' });
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
                  name: element.name + 'latest of the car v2',
                },
                native: {},
              });
              await this.json2iob.parse(vin + element.path + 'latest', datal);
            } catch (error) {
              this.log.debug(error);
            }
          }
        })
        .catch((error) => {
          if (error.response) {
            this.log.info('No charging session available. Ignore ' + vin + ' until restart');
            this.nonChargingHistory[vin] = true;
            return;
          }
          this.log.error('updateChargingSessionv2 failed');
          this.log.error(element.url);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }

  async cleanObjects() {
    for (const vin of this.vinArray) {
      const remoteState = await this.getObjectAsync(vin + '.properties');

      if (remoteState) {
        this.log.debug('clean old states' + vin);
        await this.delObjectAsync(vin + '.statusv1', { recursive: true });
        await this.delObjectAsync(vin + '.lastTrip', { recursive: true });
        await this.delObjectAsync(vin + '.allTrips', { recursive: true });
        await this.delObjectAsync(vin + '.status', { recursive: true });
        await this.delObjectAsync(vin + '.properties', { recursive: true });
        await this.delObjectAsync(vin + '.capabilities', { recursive: true });
        await this.delObjectAsync(vin + '.chargingprofile', { recursive: true });
        await this.delObjectAsync(vin + '.serviceExecutionHistory', { recursive: true });
        await this.delObjectAsync(vin + '.apiV2', { recursive: true });
        await this.delObject(vin + '.remote', { recursive: true });
        await this.delObject('_DatenNeuLaden');
        await this.delObject('_LetzterDatenabrufOK');
        await this.delObject('_LetzerFehler');
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

  async refreshToken() {
    this.log.debug('refresh token');
    await this.requestClient({
      method: 'post',
      url: 'https://customer.bmwgroup.com/gcdm/oauth/token',
      withCredentials: true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: '*/*',
        Authorization: 'Basic MzFjMzU3YTAtN2ExZC00NTkwLWFhOTktMzNiOTcyNDRkMDQ4OmMwZTMzOTNkLTcwYTItNGY2Zi05ZDNjLTg1MzBhZjY0ZDU1Mg==',
      },
      data: 'redirect_uri=com.bmw.connected://oauth&refresh_token=' + this.session.refresh_token + '&grant_type=refresh_token',
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
        return res.data;
      })
      .catch((error) => {
        this.log.error('refresh token failed');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error('Start relogin in 1min');
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
  onUnload(callback) {
    try {
      clearTimeout(this.refreshTimeout);
      clearTimeout(this.reLoginTimeout);
      clearInterval(this.updateInterval);
      clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
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
          this.log.warn('Please use remotev2 to control');
          return;
        }

        const vin = id.split('.')[2];

        let command = id.split('.')[4];
        if (command === 'force-refresh') {
          this.log.info('force refresh');
          this.updateDevices();
          return;
        }
        const action = command.split('_')[1];
        command = command.split('_')[0];

        const headers = {
          'user-agent': this.userAgentDart,
          'x-user-agent': this.xuserAgent.replace(';brand;', `;${this.config.brand};`),
          authorization: 'Bearer ' + this.session.access_token,
          'accept-language': 'de-DE',
          host: 'cocoapi.bmwgroup.com',
          '24-hour-format': 'true',
          'Content-Type': 'text/plain',
        };
        let url = 'https://cocoapi.bmwgroup.com/eadrax-vrccs/v2/presentation/remote-commands/' + vin + '/' + command;
        if (action) {
          url += '?action=' + action;
        }
        this.log.debug('Send remote command ' + command + ' to ' + vin);
        await this.requestClient({
          method: 'post',
          url: url,
          headers: headers,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error('Remote command failed');
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
        this.refreshTimeout = setTimeout(async () => {
          this.log.info('Refresh values');
          await this.updateDevices();
        }, 10 * 1000);
      } else {
        // const resultDict = { chargingStatus: "CHARGE_NOW", doorLockState: "DOOR_LOCK" };
        // const idArray = id.split(".");
        // const stateName = idArray[idArray.length - 1];
        const vin = id.split('.')[2];
        // if (resultDict[stateName]) {
        //     let value = true;
        //     if (!state.val || state.val === "INVALID" || state.val === "NOT_CHARGING" || state.val === "ERROR" || state.val === "UNLOCKED") {
        //         value = false;
        //     }
        //     await this.setStateAsync(vin + ".remote." + resultDict[stateName], value, true);
        // }

        if (id.indexOf('.chargingStatus') !== -1 && state.val !== 'CHARGING') {
          await this.setObjectNotExistsAsync(vin + '.status.chargingTimeRemaining', {
            type: 'state',
            common: {
              name: 'chargingTimeRemaining',
              role: 'value',
              type: 'number',
              write: false,
              read: true,
            },
            native: {},
          });
          this.setState(vin + '.status.chargingTimeRemaining', 0, true);
        }
      }
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
