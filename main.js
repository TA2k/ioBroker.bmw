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
        this.extractKeys = extractKeys;
        this.vinArray = [];
        this.session = {};
        this.canGen = {};
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
            });
        if (!authUrl.redirect_to) {
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
                    const remoteArray = [{ command: "lock-unlock" }];
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
                }
            })
            .catch((error) => {
                this.log.error(error);
            });
    }
    async updateVehicles() {
        const date = new Date();
        let month = date.getMonth() + 1;
        month = (month > 9 ? "" : "0") + month;
        const yyyymmm = date.getFullYear() + "" + month;
        const statusArray = [{ path: "status", url: "https://b2vapi.bmwgroup.com/webapi/v1/user/vehicles/$vin/status" }];
        const headers = {
            "Content-Type": "application/vnd.api+json",
            Accept: "*/*",

            Authorization: "Bearer " + this.session.access_token,
        };
        this.vinArray.forEach((vin) => {
            statusArray.forEach(async (element) => {
                const url = element.url.replace("$vin", vin);
                await this.requestClient({
                    method: "get",
                    url: url,
                    headers: headers,
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        let data = res.data;
                        if (data.data) {
                            data = data.data;
                        }
                        if (data.attributes) {
                            data = data.attributes;
                        }
                        const forceIndex = null;
                        const preferedArrayName = null;

                        this.extractKeys(this, vin + "." + element.path, data, preferedArrayName, forceIndex);
                    })
                    .catch((error) => {
                        if (error.response.status !== 502) {
                            this.log.error(error);
                            error.response && this.log.error(JSON.stringify(error.response.data));
                        }
                    });
            });
        });
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
            },
            data: "client_id=31c357a0-7a1d-4590-aa99-33b97244d048&grant_type=refresh_token&refresh_token=" + this.session.refresh_token,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session.access_token = res.data.access_token;
                this.setState("info.connection", true, true);
                return res.data;
            })
            .catch((error) => {
                this.log.error(error);
            });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            clearTimeout(this.refreshTimeout);

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
            } else {
                const resultDict = {};
                const idArray = id.split(".");
                const stateName = idArray[idArray.length - 1];

                if (resultDict[stateName]) {
                    const vin = id.split(".")[2];
                    let value = true;
                    if (!state.val || state.val === "off" || state.val === "unlocked") {
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
