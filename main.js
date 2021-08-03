"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const qs = require("qs");
const { extractKeys } = require("./lib/extractKeys");
const axiosCookieJarSupport = require("axios-cookiejar-support").default;
const tough = require("tough-cookie");
class Bmw extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "bmw",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        axiosCookieJarSupport(axios);
        this.cookieJar = new tough.CookieJar();
        this.requestClient = axios.create();
        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.extractKeys = extractKeys;
        this.vinArray = [];
        this.session = {};
        this.rangeMapSupport = {};

        this.subscribeStates("*");

        await this.login();
        if (this.session.access_token) {
            await this.getVehicles();
            await this.updateVehicles();
            this.updateInterval = setInterval(async () => {
                await this.updateVehicles();
            }, this.config.interval * 60 * 1000);
            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, this.session.expires_in * 1000);
        }
    }
    async login() {
        const headers = {
            Accept: "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
            "Accept-Language": "de-de",
            "Content-Type": "application/x-www-form-urlencoded",
        };
        const data = {
            client_id: "31c357a0-7a1d-4590-aa99-33b97244d048",
            response_type: "code",
            scope: "openid profile email offline_access smacc vehicle_data perseus dlm svds cesim vsapi remote_services fupo authenticate_user",
            redirect_uri: "com.bmw.connected://oauth",
            state: "cEG9eLAIi6Nv-aaCAniziE_B6FPoobva3qr5gukilYw",
            nonce: "login_nonce",
            username: this.config.username,
            password: this.config.password,
            grant_type: "authorization_code",
        };
        const authUrl = await this.requestClient({
            method: "post",
            url: "https://customer.bmwgroup.com/gcdm/oauth/authenticate",
            headers: headers,
            data: qs.stringify(data),
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                return res.data;
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
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
            method: "post",
            url: "https://customer.bmwgroup.com/gcdm/oauth/authenticate",
            headers: headers,
            data: qs.stringify(data),
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                return res.data;
            })
            .catch((error) => {
                let code = "";
                if (error.response && error.response.status === 400) {
                    this.log.error(JSON.stringify(error.response.data));
                    return;
                }
                if (error.config) {
                    this.log.debug(JSON.stringify(error.config.url));
                    code = qs.parse(error.config.url.split("?")[1]).code;
                    this.log.debug(code);
                    return code;
                }
            });
        await this.requestClient({
            method: "post",
            url: "https://customer.bmwgroup.com/gcdm/oauth/token",

            jar: this.cookieJar,
            withCredentials: true,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": "My%20BMW/8932 CFNetwork/978.0.7 Darwin/18.7.0",
                Accept: "*/*",
                "Accept-Language": "de-de",
                Authorization: "Basic MzFjMzU3YTAtN2ExZC00NTkwLWFhOTktMzNiOTcyNDRkMDQ4OmMwZTMzOTNkLTcwYTItNGY2Zi05ZDNjLTg1MzBhZjY0ZDU1Mg==",
            },
            data: "code=" + code + "&code_verifier=7PsmfPS5MpaNt0jEcPpi-B7M7u0gs1Nzw6ex0Y9pa-0&redirect_uri=com.bmw.connected://oauth&grant_type=authorization_code",
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
                return res.data;
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
    }
    async getVehicles() {
        const headers = {
            "Content-Type": "application/json",
            Accept: "*/*",
            Authorization: "Bearer " + this.session.access_token,
        };

        await this.requestClient({
            method: "get",
            url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles",
            headers: headers,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                for (const vehicle of res.data.vehicles) {
                    this.vinArray.push(vehicle.vin);
                    await this.setObjectNotExistsAsync(vehicle.vin, {
                        type: "device",
                        common: {
                            name: vehicle.model,
                            role: "state",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(vehicle.vin + ".remote", {
                        type: "channel",
                        common: {
                            name: "Remote Controls",
                            role: "state",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(vehicle.vin + ".general", {
                        type: "channel",
                        common: {
                            name: "General Car Information",
                            role: "state",
                        },
                        native: {},
                    });

                    const remoteArray = [
                        { command: "CHARGE_NOW" },
                        { command: "CLIMATE_NOW" },
                        { command: "DOOR_LOCK" },
                        { command: "DOOR_UNLOCK" },
                        { command: "GET_VEHICLES" },
                        { command: "GET_VEHICLE_STATUS" },
                        { command: "HORN_BLOW" },
                        { command: "LIGHT_FLASH" },
                        { command: "VEHICLE_FINDER" },
                        { command: "CLIMATE_NOW" },
                        { command: "START_CHARGING" },
                        { command: "STOP_CHARGING" },
                        { command: "START_PRECONDITIONING" },
                    ];
                    remoteArray.forEach((remote) => {
                        this.setObjectNotExists(vehicle.vin + ".remote." + remote.command, {
                            type: "state",
                            common: {
                                name: remote.name || "",
                                type: remote.type || "boolean",
                                role: remote.role || "boolean",
                                write: true,
                                read: true,
                            },
                            native: {},
                        });
                    });
                    this.extractKeys(this, vehicle.vin + ".general", vehicle);
                    this.rangeMapSupport[vehicle.vin] = vehicle.rangeMap === "NOT_SUPPORTED" ? false : true;
                }
            })
            .catch((error) => {
                this.log.error(error);
            });
    }
    async updateVehicles() {
        const date = this.getDate();

        const statusArray = [
            { path: "status", url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles/$vin/status" },
            { path: "chargingprofile", url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles/$vin/chargingprofile" },
            { path: "lastTrip", url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles/$vin/statistics/lastTrip" },
            { path: "allTrips", url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles/$vin/statistics/allTrips" },
            { path: "serviceExecutionHistory", url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles/$vin/serviceExecutionHistory" },
            { path: "apiV2", url: "https://b2vapi.bmwgroup.com/api/vehicle/v2/$vin" },
            // { path: "socnavigation", url: "https://b2vapi.bmwgroup.com/api/vehicle/navigation/v1/$vin" },
        ];

        const headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            Authorization: "Bearer " + this.session.access_token,
        };
        this.vinArray.forEach((vin) => {
            if (this.rangeMapSupport[vin]) {
                statusArray.push({ path: "rangemap", url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles/$vin/rangemap?deviceTime=" + date });
            }
            statusArray.forEach(async (element) => {
                const url = element.url.replace("$vin", vin);
                await this.requestClient({
                    method: "get",
                    url: url,
                    headers: headers,
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        if (!res.data) {
                            return;
                        }
                        let data = res.data;
                        const keys = Object.keys(res.data);
                        if (keys.length === 1) {
                            data = res.data[keys[0]];
                        }
                        let forceIndex = null;
                        const preferedArrayName = null;
                        if (element.path === "serviceExecutionHistory") {
                            forceIndex = true;
                        }

                        this.extractKeys(this, vin + "." + element.path, data, preferedArrayName, forceIndex);
                    })
                    .catch((error) => {
                        if (error.response && error.response.status === 401) {
                            error.response && this.log.debug(JSON.stringify(error.response.data));
                            this.log.info(element.path + " receive 401 error. Refresh Token in 30 seconds");
                            clearTimeout(this.refreshTokenTimeout);
                            this.refreshTokenTimeout = setTimeout(() => {
                                this.refreshToken();
                            }, 1000 * 30);

                            return;
                        }
                        this.log.error(element.url);
                        this.log.error(error);
                        error.response && this.log.debug(JSON.stringify(error.response.data));
                    });
            });
        });
    }
    getDate() {
        const d = new Date();

        var date_format_str =
            d.getFullYear().toString() +
            "-" +
            ((d.getMonth() + 1).toString().length == 2 ? (d.getMonth() + 1).toString() : "0" + (d.getMonth() + 1).toString()) +
            "-" +
            (d.getDate().toString().length == 2 ? d.getDate().toString() : "0" + d.getDate().toString()) +
            "T" +
            (d.getHours().toString().length == 2 ? d.getHours().toString() : "0" + d.getHours().toString()) +
            ":" +
            (d.getMinutes().toString().length == 2 ? d.getMinutes().toString() : "0" + d.getMinutes().toString()) +
            ":00";
        return date_format_str;
    }

    async refreshToken() {
        await this.requestClient({
            method: "post",
            url: "https://customer.bmwgroup.com/gcdm/oauth/token",
            jar: this.cookieJar,
            withCredentials: true,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
                Accept: "application/json",
                Authorization: "Basic MzFjMzU3YTAtN2ExZC00NTkwLWFhOTktMzNiOTcyNDRkMDQ4OmMwZTMzOTNkLTcwYTItNGY2Zi05ZDNjLTg1MzBhZjY0ZDU1Mg==",
            },
            data: "redirect_uri=com.bmw.connected://oauth&refresh_token=" + this.session.refresh_token + "&grant_type=refresh_token",
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session.access_token = res.data;
                this.setState("info.connection", true, true);
                return res.data;
            })
            .catch((error) => {
                this.log.error("refresh token failed");
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
                this.log.error("Start relogin in 1min");
                this.reLoginTimeout = setTimeout(() => {
                    this.login();
                }, 1000 * 60 * 1);
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
            clearTimeout(this.refreshTokenTimeout);
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
                const vin = id.split(".")[2];
                const command = id.split(".")[4];
                const headers = {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "*/*",
                    Authorization: "Bearer " + this.session.access_token,
                };
                let data = {
                    serviceType: command,
                };
                if (command === "DOOR_UNLOCK") {
                    data.bmwSkAnswer = this.config.bmwSkAnswer;
                }
                await this.requestClient({
                    method: "post",
                    url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles/" + vin + "/executeService",
                    headers: headers,
                    data: qs.stringify(data),
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        return res.data;
                    })
                    .catch((error) => {
                        this.log.error(error);
                        if (error.response) {
                            this.log.error(JSON.stringify(error.response.data));
                        }
                    });
                this.refreshTimeout = setTimeout(async () => {
                    await this.updateVehicles();
                }, 10 * 1000);
            } else {
                const resultDict = { chargingStatus: "CHARGE_NOW", doorLockState: "DOOR_LOCK" };
                const idArray = id.split(".");
                const stateName = idArray[idArray.length - 1];

                if (resultDict[stateName]) {
                    const vin = id.split(".")[2];
                    let value = true;
                    if (!state.val || state.val === "INVALID" || state.val === "NOT_CHARGING" || state.val === "ERROR" || state.val === "UNLOCKED") {
                        value = false;
                    }
                    await this.setStateAsync(vin + ".remote." + resultDict[stateName], value, true);
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
