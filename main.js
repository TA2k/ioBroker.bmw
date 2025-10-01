'use strict';

// The adapter-core module gives you access to the core ioBroker functions you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios');

const { HttpsCookieAgent } = require('http-cookie-agent/http');
const crypto = require('crypto');
const qs = require('qs');
const Json2iob = require('json2iob');
const tough = require('tough-cookie');
const axiosRetry = require('axios-retry').default;
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

		// @ts-expect-error comment
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
		this.setState('info.connection', false, true);
		this.setState('info.mqttConnected', false, true);

		// Validate configuration
		if (!this.config.clientId) {
			this.log.error('BMW CarData Client ID not configured! Please set up in adapter settings.');
			this.log.info('Visit BMW ConnectedDrive portal, go to CarData section, and generate a client ID');
			return;
		}

		if (this.config.interval < 10) {
			this.log.info('Setting minimum interval to 10 minutes due to API quota limits');
			this.config.interval = 10;
		}

		this.subscribeStates('*');

		// Initialize API quota tracking
		this.apiCalls = [];

		// Try to restore stored session
		const sessionState = await this.getStateAsync('cardataauth.session');
		if (sessionState?.val && typeof sessionState.val === 'string') {
			try {
				this.session = JSON.parse(sessionState.val);
				this.log.info('Found stored BMW CarData session');

				// Try to refresh tokens
				await this.refreshToken();
			} catch (error) {
				this.log.warn('Failed to parse stored session, starting new login');
				await this.login();
			}
		} else {
			this.log.info('No stored session found, starting BMW CarData authorization');
			await this.login();
		}

		// Proceed if we have valid tokens
		if (this.session.access_token && this.session.gcid) {
			this.log.info('Starting BMW CarData vehicle discovery...');

			// Get vehicles and fetch all initial data
			await this.getVehiclesv2(true);

			// Clean up old states from previous versions
			await this.cleanObjects();

			// Start periodic token refresh (every 45 minutes)
			this.refreshTokenInterval = setInterval(async () => {
				await this.refreshToken();
			}, 45 * 60 * 1000);

			// Start periodic API updates (respecting quota limits)
			if (this.vinArray.length > 0) {
				this.log.info(`Setting up periodic updates every ${this.config.interval} minutes for ${this.vinArray.length} vehicle(s)`);
				this.updateInterval = setInterval(async () => {
					// Simple periodic data refresh - MQTT provides real-time updates
					for (const vin of this.vinArray) {
						if (this.checkQuota()) {
							this.log.debug(`Periodic API refresh for ${vin}`);
							// Could add specific periodic API calls here if needed
							break; // Only one call per interval to conserve quota
						} else {
							this.log.debug('Skipping periodic API call - quota exhausted');
							break;
						}
					}
				}, this.config.interval * 60 * 1000);
			}

			this.log.info('BMW CarData adapter startup complete');
			this.log.info('MQTT streaming: enabled');
			this.log.info(`API quota: ${50 - this.apiCalls.length}/50 calls remaining`);
		} else {
			this.log.error('BMW CarData authentication failed');
		}
	}

	async login() {
		if (!this.config.clientId) {
			this.log.error('BMW CarData Client ID not configured! Please set up in adapter settings.');
			return false;
		}

		const codeVerifier = crypto.randomBytes(32).toString('base64url');
		const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

		try {
			// Step 1: Get device code
			this.log.debug('Starting BMW CarData device authorization flow');
			this.log.debug(`Auth API Base: ${this.authApiBase}`);
			this.log.debug(`Client ID: ${this.config.clientId}`);
			this.log.debug(`Code Challenge: ${codeChallenge}`);

			const requestData = {
				client_id: this.config.clientId,
				response_type: 'device_code',
				scope: 'authenticate_user openid cardata:streaming:read cardata:api:read',
				code_challenge: codeChallenge,
				code_challenge_method: 'S256'
			};
			this.log.debug('Device code request data: ' + JSON.stringify(requestData));

			const deviceResponse = await this.requestClient({
				method: 'post',
				url: `${this.authApiBase}/device/code`,
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Accept': 'application/json'
				},
				data: requestData
			})
			.then(res => {
				this.log.debug('Device code response: ' + JSON.stringify(res.data));
				return res;
			})
			.catch(error => {
				this.log.error('Device code request failed: ' + error.message);
				
				if (error.response) {
					this.log.error('Response status: ' + error.response.status);
					this.log.error('Response headers: ' + JSON.stringify(error.response.headers));
					this.log.error('Response data: ' + JSON.stringify(error.response.data));
				}
	
				return false; // Return false instead of throwing
			});

			if (!deviceResponse) {
				return false; // Exit if device code request failed
			}

			const { user_code, device_code, verification_uri_complete, expires_in, interval } = deviceResponse.data;
			this.log.debug(`Device code: ${device_code}, User code: ${user_code}, Expires in: ${expires_in}s, Interval: ${interval}s`);

			// Show user instructions
			this.log.info('='.repeat(80));
			this.log.info('BMW CARDATA AUTHORIZATION REQUIRED');
			this.log.info('='.repeat(80));
			this.log.info(`1. Visit: ${verification_uri_complete}`);
			this.log.info(`2. Or visit: ${deviceResponse.data.verification_uri} and enter code: ${user_code}`);
			this.log.info(`3. Login with your BMW account and authorize`);
			this.log.info(`4. Code expires in ${Math.floor(expires_in/60)} minutes`);
			this.log.info('The adapter will automatically continue after authorization');
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
						code_verifier: codeVerifier
					};
					this.log.debug('Token request data: ' + JSON.stringify(tokenRequestData));

					const tokenResponse = await this.requestClient({
						method: 'post',
						url: `${this.authApiBase}/token`,
						headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						data: qs.stringify(tokenRequestData)
					});

					// Success! Store tokens in existing session structure
					this.session = tokenResponse.data;

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
					this.log.info('BMW CarData authorization successful!');

					// Connect MQTT after successful auth
					await this.connectMQTT();
					return true;

				} catch (error) {
					const errorCode = error.response?.data?.error;
					this.log.debug('Token polling error: ' + (errorCode || error.message));

					if (errorCode === 'authorization_pending') {
						this.log.debug('Authorization still pending, continuing to poll...');
						continue; // Keep polling
					} else if (errorCode === 'slow_down') {
						this.log.debug('Rate limit hit, slowing down polling...');
						await this.sleep(5000); // Additional delay
						continue;
					} else if (errorCode === 'expired_token') {
						this.log.error('Authorization code expired, please restart adapter');
						return false;
					} else {
						this.log.error('Token request failed: ' + (errorCode || error.message));
						if (error.response) {
							this.log.error('Token response status: ' + error.response.status);
							this.log.error('Token response data: ' + JSON.stringify(error.response.data));
						}
						return false;
					}
				}
			}

			this.log.error('Authorization timed out');
			return false;

		} catch (error) {
			this.log.error('Device flow failed:', error.message);
			this.log.error('Error stack:', error.stack);
			if (error.response) {
				this.log.error('Response status:', error.response.status);
				this.log.error('Response headers:', JSON.stringify(error.response.headers));
				this.log.error('Response data:', JSON.stringify(error.response.data));
			}
			if (error.request) {
				this.log.error('Request details:', {
					method: error.request.method,
					url: error.request.url,
					headers: error.request._headers
				});
			}
			return false;
		}
	}

	generateBuildString() {
		// Generate 6-digit numeric component
		const numeric = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
		
		// Generate 3-digit build number
		const buildNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
		
		return `AP2A.${numeric}.${buildNum}`;
	}

	getCodeChallenge() {
		let hash = '';
		let result = '';
		const chars = '0123456789abcdef';
		result = '';
		for (let i = 64; i > 0; --i) {
			result += chars[Math.floor(Math.random() * chars.length)];
		}
		hash = crypto.createHash('sha256').update(result).digest('base64');
		hash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

		return [result, hash];
	}

	async getVehiclesv2(firstStart) {
		const headers = {
			'Authorization': `Bearer ${this.session.access_token}`,
			'x-version': 'v1',
			'Accept': 'application/json'
		};

		this.log.debug('Fetching BMW CarData vehicle mappings');
		await this.requestClient({
			method: 'get',
			url: `${this.carDataApiBase}/customers/vehicles/mappings`,
			headers: headers
		})
		.then(async res => {
			this.log.debug(JSON.stringify(res.data));
			const mappings = res.data;

			if (firstStart) {
				this.log.info(`Found ${mappings.length} BMW vehicles`);
			}

			if (mappings.length === 0) {
				this.log.info('No BMW vehicles found in CarData mappings');
				return;
			}

			for (const mapping of mappings) {
				if (mapping.mappingType === 'PRIMARY' && mapping.vin) {
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

					// Create vehicle device
					await this.extendObject(vin, {
						type: 'device',
						common: {
							name: vin // Will be updated with model name when basic data is fetched
						},
						native: {}
					});

					// Fetch all available data for this vehicle on first start
					if (firstStart) {
						await this.fetchAllVehicleData(vin, headers);
					}
				}
			}
		})
		.catch(error => {
			this.log.error('BMW CarData vehicle discovery failed: ' + error.message);
			if (error.response) {
				this.log.error('Response: ' + JSON.stringify(error.response.data));
				if (error.response.status === 403 || error.response.status === 429) {
					this.log.warn('Rate limit exceeded or access denied');
				}
			}
		});

		await this.sleep(2000);
	}

	// Fetch ALL available API endpoints for each vehicle
	async fetchAllVehicleData(vin, headers) {
		const apiEndpoints = [
			{
				name: 'basicData',
				url: `/customers/vehicles/${vin}/basicData`,
				channel: 'Basic Information'
			},
			{
				name: 'chargingHistory',
				url: `/customers/vehicles/${vin}/chargingHistory`,
				channel: 'Charging History'
			},
			{
				name: 'image',
				url: `/customers/vehicles/${vin}/image`,
				channel: 'Vehicle Image'
			},
			{
				name: 'locationBasedChargingSettings',
				url: `/customers/vehicles/${vin}/locationBasedChargingSettings`,
				channel: 'Location Charging Settings'
			},
			{
				name: 'smartMaintenanceTyreDiagnosis',
				url: `/customers/vehicles/${vin}/smartMaintenanceTyreDiagnosis`,
				channel: 'Tyre Diagnosis'
			},
			{
				name: 'telematicData',
				url: `/customers/vehicles/${vin}/telematicData`,
				channel: 'Telematic Data'
			}
		];

		this.log.info(`Fetching all available data for ${vin}...`);

		for (const endpoint of apiEndpoints) {
			if (!this.checkQuota()) {
				this.log.warn(`Skipping ${endpoint.name} for ${vin} - API quota exhausted`);
				break;
			}

			try {
				this.log.debug(`Fetching ${endpoint.name} for ${vin}`);
				const response = await this.requestClient({
					method: 'get',
					url: `${this.carDataApiBase}${endpoint.url}`,
					headers: headers
				});

				// Store data with json2iob (no conversion needed!)
				await this.json2iob.parse(`${vin}.${endpoint.name}`, response.data, {
					channelName: endpoint.channel,
					descriptions: this.description,
					forceIndex: true
				});

				// Update vehicle name if we got basic data
				if (endpoint.name === 'basicData' && response.data) {
					const vehicleName = `${response.data.brand || 'BMW'} ${response.data.modelName || response.data.series || vin}`.trim();
					await this.extendObject(vin, {
						type: 'device',
						common: {
							name: vehicleName
						},
						native: {
							brand: response.data.brand,
							model: response.data.modelName,
							series: response.data.series,
							vin: vin
						}
					});
					this.log.info(`Updated vehicle name: ${vehicleName} (${vin})`);
				}

				this.log.debug(`✓ ${endpoint.name} for ${vin}`);
				await this.sleep(1000); // Rate limiting between calls

			} catch (error) {
				// Some endpoints might not be available for all vehicles
				const status = error.response?.status;
				if (status === 404) {
					this.log.debug(`${endpoint.name} not available for ${vin} (404)`);
				} else if (status === 403) {
					this.log.warn(`${endpoint.name} access denied for ${vin} (403)`);
				} else {
					this.log.debug(`${endpoint.name} failed for ${vin}: ${error.message}`);
				}
			}
		}
	}

	checkQuota() {
		const now = Date.now();
		if (!this.apiCalls) this.apiCalls = [];

		// Remove calls older than 24h
		this.apiCalls = this.apiCalls.filter(time => now - time < 24 * 60 * 60 * 1000);

		const used = this.apiCalls.length;
		const remaining = 50 - used;

		// Update quota states
		this.setState('info.apiQuotaUsed', used, true);
		this.setState('info.apiQuotaRemaining', remaining, true);

		if (remaining > 0) {
			this.apiCalls.push(now);
			return true;
		}

		this.log.warn(`API quota exhausted: ${used}/50 calls used in last 24h`);
		return false;
	}

	async updateDevices() {
		const brand = this.config.brand;
		const headers = {
			'user-agent': this.userAgentDart,
			'x-user-agent': this.xuserAgent.replace(`;brand;`, `;${brand};`),
			authorization: `Bearer ${this.session.access_token}`,
			'accept-language': 'de-DE',
			host: 'cocoapi.bmwgroup.com',
			'24-hour-format': 'true',
		};
		for (const vin of this.vinArray) {
			this.log.debug(`update ${vin}`);
			headers['bmw-vin'] = vin;
			await this.requestClient({
				method: 'get',
				url: `https://cocoapi.bmwgroup.com/eadrax-vcs/v4/vehicles/state?apptimezone=120&appDateTime=${Date.now()}&tireGuardMode=ENABLED`,
				headers: headers,
			})
				.then(async res => {
					this.log.debug(JSON.stringify(res.data));
					if (
						res.data.state &&
						res.data.state.electricChargingState &&
						!res.data.state.electricChargingState.remainingChargingMinutes
					) {
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
				.catch(async error => {
					if (error.response && error.response.status === 429) {
						this.log.debug(`${error.response.data.message} - retrying in 5 seconds`);
						await this.sleep(5000);
						await this.updateDevices();
						return;
					}
					if (error.response && error.response.status === 403) {
						this.log.warn(error.response.data.message);
						return;
					}
					if (error.response && error.response.status >= 500) {
						this.log.warn(`BMW server is not available`);
					}
					this.log.warn(`update failed`);
					this.log.warn(error);
					error.response && this.log.warn(JSON.stringify(error.response.data));
				});
			await this.updateChargingSessionv2(vin);
			await this.sleep(10000);
		}
	}

	async updateDemands() {
		const brand = this.config.brand;
		const headers = {
			'user-agent': this.userAgentDart,
			'x-user-agent': this.xuserAgent.replace(`;brand;`, `;${brand};`),
			authorization: `Bearer ${this.session.access_token}`,
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
				.then(async res => {
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
				.catch(async error => {
					if (error.response && error.response.status === 429) {
						this.log.debug(`${error.response.data.message} retrying in 15 minutes`);
						await this.sleep(15 * 60000);
						await this.updateDemands();
						return;
					}
					if (error.response && error.response.status === 403) {
						this.log.warn(error.response.data.message);
						return;
					}
					if (error.response && error.response.status >= 500) {
						this.log.error(`BMW server is not available`);
					}
					this.log.error(`update demand failed`);
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
			authorization: `Bearer ${this.session.access_token}`,
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
				.then(async res => {
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
				.catch(async error => {
					if (error.response && error.response.status === 429) {
						this.log.debug(`${error.response.data.message} - retrying in 15 minutes`);
						await this.sleep(15 * 60000);
						await this.updateTrips();
						return;
					}
					if (error.response && error.response.status === 403) {
						this.log.warn(error.response.data.message);
						return;
					}
					if (error.response && error.response.status >= 500) {
						this.log.error(`BMW server is not available`);
					}
					this.log.error(`update trip failed`);
					this.log.error(error);
					error.response && this.log.error(JSON.stringify(error.response.data));
				});
			await this.sleep(10000);
		}
	}

	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
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
			authorization: `Bearer ${this.session.access_token}`,
			'accept-language': 'de-DE',
			'24-hour-format': 'true',
			'bmw-vin': vin,
		};

		const d = new Date();
		let dateFormatted = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
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
				.then(async res => {
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
								this.log.debug(error.message);
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
							await this.setObjectNotExistsAsync(`${vin}${element.path}latest`, {
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
				.catch(error => {
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
			// Check if this is an upgrade from old version by looking for remotev2 states
			const remoteState = await this.getObjectAsync(`${vin}.remotev2`);
			if (remoteState) {
				this.log.info(`Cleaning old states for ${vin} (upgrading from previous version)`);

				// Delete all old state structures recursively
				await this.delObjectAsync(`${vin}`, { recursive: true });

				// Create fresh vehicle device
				await this.extendObject(vin, {
					type: 'device',
					common: { name: vin },
					native: {}
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
					await this.delObject(`${vin}.remote`, { recursive: true });
				}
			}
		}

		// Clean up old global states
		await this.delObject(`_DatenNeuLaden`);
		await this.delObject(`_LetzterDatenabrufOK`);
		await this.delObject(`_LetzerFehler`);

		// Clean up old authentication objects (v3.x used different auth structure)
		const oldAuthObjects = await this.getObjectAsync('auth');
		if (oldAuthObjects) {
			this.log.info('Cleaning up complete old auth folder from previous version');
			await this.delObjectAsync('auth', { recursive: true });
		}
	}

	getDate() {
		const d = new Date();
		const date_format_str = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}T${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:00`;
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
			authorization: `'Bearer ${this.session.access_token}`,
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
				.then(async res => {
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
				.catch(error => {
					this.log.error(`fetch images failed ${view}`);
					this.log.error(error);
					error.response && this.log.error(JSON.stringify(error.response.data));
				});
			await this.sleep(5000);
		}
	}

	async refreshToken() {
		if (!this.session.refresh_token) {
			this.log.error('No refresh token available, starting new device flow');
			return await this.login();
		}

		this.log.debug('Refreshing BMW CarData tokens');
		this.log.debug(`Refresh token URL: ${this.authApiBase}/token`);
		this.log.debug(`Client ID: ${this.config.clientId}`);

		const refreshData = {
			grant_type: 'refresh_token',
			refresh_token: this.session.refresh_token,
			client_id: this.config.clientId
		};
		this.log.debug('Refresh request data: ' + JSON.stringify(refreshData));

		await this.requestClient({
			method: 'post',
			url: `${this.authApiBase}/token`,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			data: qs.stringify(refreshData)
		})
		.then(async res => {
			// Store refreshed tokens (keep existing session structure)
			this.session = res.data;
			this.setState('cardataauth.session', JSON.stringify(this.session), true);
			this.setState('info.connection', true, true);
			this.log.debug('Tokens refreshed successfully');

			// IMPORTANT: Reconnect MQTT with new token
			if (this.mqtt) {
				this.log.debug('Reconnecting MQTT with new token');
				this.mqtt.end();
				await this.sleep(2000);
				await this.connectMQTT();
			}

			return res.data;
		})
		.catch(async error => {
			this.log.error('Token refresh failed:', error.message);
			this.log.error('Error stack:', error.stack);
			if (error.response) {
				this.log.error('Response status:', error.response.status);
				this.log.error('Response headers:', JSON.stringify(error.response.headers));
				this.log.error('Response data:', JSON.stringify(error.response.data));
			}
			if (error.request) {
				this.log.error('Request details:', {
					method: error.request.method,
					url: error.request.url,
					headers: error.request._headers
				});
			}
			this.log.info('Starting new device authorization flow');
			return await this.login();
		});
	}

	async connectMQTT() {
		if (!this.session.id_token || !this.session.gcid) {
			this.log.warn('No MQTT credentials available (missing ID token or GCID)');
			return false;
		}

		const mqtt = require('mqtt');

		const options = {
			host: 'customer.streaming-cardata.bmwgroup.com',
			port: 9000,
			protocol: 'mqtts',
			username: this.session.gcid,
			password: this.session.id_token,
			keepalive: 30,
			clean: true,
			rejectUnauthorized: true,
			reconnectPeriod: 5000,
			connectTimeout: 30000
		};

		this.log.debug(`Connecting to BMW MQTT: ${options.host}:${options.port}`);
		this.mqtt = mqtt.connect(options);

		this.mqtt.on('connect', () => {
			this.log.info('BMW MQTT stream connected');
			this.setState('info.mqttConnected', true, true);

			// Subscribe to all vehicle topics for this GCID
			const topic = `${this.session.gcid}/+`;
			this.mqtt.subscribe(topic, (err) => {
				if (err) {
					this.log.error('MQTT subscription failed: ' + err.message);
				} else {
					this.log.debug(`Subscribed to MQTT topic: ${topic}`);
				}
			});
		});

		this.mqtt.on('message', (topic, message) => {
			this.handleMQTTMessage(topic, message);
		});

		this.mqtt.on('error', (error) => {
			this.log.error('MQTT error: ' + error.message);
			this.setState('info.mqttConnected', false, true);
		});

		this.mqtt.on('close', () => {
			this.log.warn('MQTT connection closed');
			this.setState('info.mqttConnected', false, true);
		});

		this.mqtt.on('reconnect', () => {
			this.log.debug('MQTT reconnecting...');
		});

		return true;
	}

	async handleMQTTMessage(topic, message) {
		try {
			const data = JSON.parse(message.toString());
			const topicParts = topic.split('/');

			if (topicParts.length >= 2) {
				const gcid = topicParts[0];
				const vin = topicParts[1];

				if (gcid === this.session.gcid && data.vin && data.data) {
					this.log.debug(`MQTT: ${vin} - ${Object.keys(data.data).length} data points`);

					// Ensure VIN is in our array
					if (!this.vinArray.includes(vin)) {
						this.vinArray.push(vin);
					}

					// Create vehicle device if not exists
					await this.extendObject(vin, {
						type: 'device',
						common: { name: vin },
						native: {}
					});

					// Process data with json2iob (no conversion needed!)
					await this.json2iob.parse(vin, data.data, {
						forceIndex: true,
						descriptions: this.description,
						channelName: 'MQTT Stream'
					});

					// Add metadata
					await this.setState(`${vin}.lastUpdate`, new Date().toISOString(), true);
					await this.setState(`${vin}.dataSource`, 'mqtt', true);
				}
			}
		} catch (error) {
			this.log.warn('Failed to parse MQTT message: ' + error.message);
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
			clearInterval(this.updateInterval);
			clearInterval(this.refreshTokenInterval);

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
			// BMW CarData API is read-only, no remote controls available
			this.log.warn('Remote controls not available in BMW CarData (read-only API)');
			this.log.info('BMW CarData only provides vehicle data, no command functionality');

			// Reset the state to acknowledge it
			this.setState(id, state.val, true);
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
	 * @param {Partial<utils.AdapterOptions>} [options] - Optional adapter configuration options.
	 */
	module.exports = options => new Bmw(options);
} else {
	// otherwise start the instance directly
	new Bmw();
}
