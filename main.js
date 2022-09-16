"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");

const { HttpsCookieAgent } = require("http-cookie-agent/http");
const crypto = require("crypto");
const qs = require("qs");
const { extractKeys } = require("./lib/extractKeys");
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
    this.userAgent = "My%20BMW/8932 CFNetwork/978.0.7 Darwin/18.7.0";
    this.userAgentDart = "Dart/2.14 (dart:io)";
    this.xuserAgent = "android(SP1A.210812.016.C1);brand;99.0.0(99999);row";
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.extractKeys = extractKeys;
    this.vinArray = [];
    this.session = {};
    this.statusBlock = {};
    this.nonChargingHistory = {};
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
    this.cookieJar = new tough.CookieJar(null, { ignoreError: true });

    this.requestClient = axios.create({
      jar: this.cookieJar,
      withCredentials: true,
      httpsAgent: new HttpsCookieAgent({ cookies: { jar: this.cookieJar } }),
    });

    this.subscribeStates("*");
    if (!this.config.username || !this.config.password) {
      this.log.error("Please set username and password");
      return;
    }
    await this.login();
    if (this.session.access_token) {
      // await this.getVehicles(); //old depracted api
      await this.cleanObjects();
      await this.getVehiclesv2();
      this.updateInterval = setInterval(async () => {
        await this.getVehiclesv2();
      }, this.config.interval * 60 * 1000);
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, this.session.expires_in * 1000);
    }
  }
  async login() {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
      "Accept-Language": "de-de",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const [code_verifier, codeChallenge] = this.getCodeChallenge();
    const data = {
      client_id: "31c357a0-7a1d-4590-aa99-33b97244d048",
      response_type: "code",
      scope: "openid profile email offline_access smacc vehicle_data perseus dlm svds cesim vsapi remote_services fupo authenticate_user",
      redirect_uri: "com.bmw.connected://oauth",
      state: "cwU-gIE27j67poy2UcL3KQ",
      nonce: "login_nonce",
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
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
        this.log.error("Login failed");
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
        if (error.response && error.response.status === 401) {
          this.log.error("Please check username and password or too many logins in 5 minutes");

          this.log.error("Start relogin in 5min");
          this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
          this.reLoginTimeout = setTimeout(() => {
            this.login();
          }, 5000 * 60 * 1);
        }
        if (error.response && error.response.status === 400) {
          this.log.error("Please check username and password");
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
      maxRedirects: 0,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        let code = "";
        if (error.response && error.response.status >= 400) {
          this.log.error(JSON.stringify(error.response.data));
          return;
        }
        if (error.response.status === 302) {
          this.log.debug(JSON.stringify(error.response.headers.location));
          code = qs.parse(error.response.headers.location.split("?")[1]).code;
          this.log.debug(code);
          return code;
        }
        this.log.error(error);
        return;
      });
    await this.requestClient({
      method: "post",
      url: "https://customer.bmwgroup.com/gcdm/oauth/token",

      jar: this.cookieJar,
      withCredentials: true,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": this.userAgent,
        Accept: "*/*",
        "Accept-Language": "de-de",
        Authorization: "Basic MzFjMzU3YTAtN2ExZC00NTkwLWFhOTktMzNiOTcyNDRkMDQ4OmMwZTMzOTNkLTcwYTItNGY2Zi05ZDNjLTg1MzBhZjY0ZDU1Mg==",
      },
      data: "code=" + code + "&redirect_uri=com.bmw.connected://oauth&grant_type=authorization_code&code_verifier=" + code_verifier,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState("info.connection", true, true);
        return res.data;
      })
      .catch((error) => {
        this.log.error("Login step 3 failed");
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
  }
  getCodeChallenge() {
    let hash = "";
    let result = "";
    const chars = "0123456789abcdef";
    result = "";
    for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
    hash = crypto.createHash("sha256").update(result).digest("base64");
    hash = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    return [result, hash];
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
            },
            native: {},
          });
          // await this.setObjectNotExistsAsync(vehicle.vin + ".remote", {
          //     type: "channel",
          //     common: {
          //         name: "Remote Controls",
          //     },
          //     native: {},
          // });
          await this.setObjectNotExistsAsync(vehicle.vin + ".general", {
            type: "channel",
            common: {
              name: "General Car Information",
            },
            native: {},
          });

          this.extractKeys(this, vehicle.vin + ".general", vehicle);
        }
      })
      .catch((error) => {
        this.log.error("getVehicles failed");
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async getVehiclesv2() {
    const brands = ["bmw", "mini"];
    for (const brand of brands) {
      this.log.debug(`Start getting ${brand} vehicles`);
      const headers = {
        "user-agent": this.userAgentDart,
        "x-user-agent": this.xuserAgent.replace(";brand;", `;${brand};`),
        authorization: "Bearer " + this.session.access_token,
        "accept-language": "de-DE",
        host: "cocoapi.bmwgroup.com",
        "24-hour-format": "true",
      };

      await this.requestClient({
        method: "get",
        url: "https://cocoapi.bmwgroup.com/eadrax-vcs/v1/vehicles?apptimezone=120&appDateTime=" + Date.now() + "&tireGuardMode=ENABLED",
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));

          for (const vehicle of res.data) {
            await this.setObjectNotExistsAsync(vehicle.vin, {
              type: "device",
              common: {
                name: vehicle.model,
              },
              native: {},
            });

            await this.setObjectNotExistsAsync(vehicle.vin + ".properties", {
              type: "channel",
              common: {
                name: "Current status of the car v2",
              },
              native: {},
            });
            await this.setObjectNotExistsAsync(vehicle.vin + ".remotev2", {
              type: "channel",
              common: {
                name: "Remote Controls",
              },
              native: {},
            });

            const remoteArray = [
              { command: "door-lock" },
              { command: "door-unlock" },
              { command: "horn-blow" },
              { command: "light-flash" },
              { command: "vehicle-finder" },
              { command: "climate-now_START" },
              { command: "climate-now_STOP" },
              { command: "force-refresh", name: "Force Refresh" },
            ];
            remoteArray.forEach((remote) => {
              this.setObjectNotExists(vehicle.vin + ".remotev2." + remote.command, {
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
            this.extractKeys(this, vehicle.vin, vehicle, null, true);
            await this.sleep(5000);
            this.updateChargingSessionv2(vehicle.vin);
          }
        })
        .catch((error) => {
          this.log.error("getvehicles v2 failed");
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
      await this.sleep(5000);
    }
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async updateChargingSessionv2(vin) {
    if (this.nonChargingHistory[vin]) {
      return;
    }
    const headers = {
      "user-agent": this.userAgentDart,
      "x-user-agent": this.xuserAgent.replace(";brand;", `;bmw;`),
      authorization: "Bearer " + this.session.access_token,
      "accept-language": "de-DE",
      "24-hour-format": "true",
    };
    const d = new Date();
    const dateFormatted =
      d.getFullYear().toString() +
      "-" +
      ((d.getMonth() + 1).toString().length == 2 ? (d.getMonth() + 1).toString() : "0" + (d.getMonth() + 1).toString());
    // const day = d.getDate().toString().length == 2 ? d.getDate().toString() : "0" + d.getDate().toString();
    const fullDate = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().replace("Z", "000");

    const urlArray = [];
    urlArray.push({
      url:
        "https://cocoapi.bmwgroup.com/eadrax-chs/v1/charging-sessions?vin=" +
        vin +
        "&next_token&date=" +
        dateFormatted +
        "-01T00%3A00%3A00.000Z&maxResults=40&include_date_picker=true",
      path: ".chargingSessions.",
      name: "chargingSessions",
    });

    urlArray.push({
      url: "https://cocoapi.bmwgroup.com/eadrax-chs/v1/charging-statistics?vin=" + vin + "&currentDate=" + fullDate,
      path: ".charging-statistics.",
      name: "Charging statistics",
    });
    for (const element of urlArray) {
      await this.requestClient({
        method: "get",
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
            type: "channel",
            common: {
              name: element.name + " of the car v2",
            },
            native: {},
          });

          this.extractKeys(this, vin + element.path + dateFormatted, data);
        })
        .catch((error) => {
          if (error.response) {
            this.log.info("No charging session available. Ignore " + vin + "until restart");
            this.nonChargingHistory[vin] = true;
            return;
          }
          this.log.error("updateChargingSessionv2 failed");
          this.log.error(element.url);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }

  async cleanObjects() {
    for (const vin of this.vinArray) {
      const remoteState = await this.getObjectAsync(vin + ".apiV2");

      if (remoteState) {
        this.log.debug("clean old states" + vin);
        await this.delObjectAsync(vin + ".statusv1", { recursive: true });
        await this.delObjectAsync(vin + ".lastTrip", { recursive: true });
        await this.delObjectAsync(vin + ".allTrips", { recursive: true });
        await this.delObjectAsync(vin + ".status", { recursive: true });
        await this.delObjectAsync(vin + ".chargingprofile", { recursive: true });
        await this.delObjectAsync(vin + ".serviceExecutionHistory", { recursive: true });
        await this.delObjectAsync(vin + ".apiV2", { recursive: true });
        await this.delObject(vin + ".remote", { recursive: true });
        await this.delObject("_DatenNeuLaden");
        await this.delObject("_LetzterDatenabrufOK");
        await this.delObject("_LetzerFehler");
      }
    }
  }
  getDate() {
    const d = new Date();

    const date_format_str =
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
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "*/*",
        Authorization: "Basic MzFjMzU3YTAtN2ExZC00NTkwLWFhOTktMzNiOTcyNDRkMDQ4OmMwZTMzOTNkLTcwYTItNGY2Zi05ZDNjLTg1MzBhZjY0ZDU1Mg==",
      },
      data: "redirect_uri=com.bmw.connected://oauth&refresh_token=" + this.session.refresh_token + "&grant_type=refresh_token",
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState("info.connection", true, true);
        return res.data;
      })
      .catch((error) => {
        this.log.error("refresh token failed");
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error("Start relogin in 1min");
        this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
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
        if (id.indexOf(".remotev2.") === -1) {
          this.log.warn("Please use remotev2 to control");
          return;
        }

        const vin = id.split(".")[2];

        let command = id.split(".")[4];
        if (command === "force-refresh") {
          this.log.info("force refresh");
          this.getVehiclesv2();
          return;
        }
        const action = command.split("_")[1];
        command = command.split("_")[0];

        const headers = {
          "user-agent": this.userAgentDart,
          "x-user-agent": this.xuserAgent.replace(";brand;", `;bmw;`),
          authorization: "Bearer " + this.session.access_token,
          "accept-language": "de-DE",
          host: "cocoapi.bmwgroup.com",
          "24-hour-format": "true",
          "Content-Type": "text/plain",
        };
        let url = "https://cocoapi.bmwgroup.com/eadrax-vrccs/v2/presentation/remote-commands/" + vin + "/" + command;
        if (action) {
          url += "?action=" + action;
        }

        await this.requestClient({
          method: "post",
          url: url,
          headers: headers,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error("Remote command failed");
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
        this.refreshTimeout = setTimeout(async () => {
          this.log.info("Refresh values");
          await this.getVehiclesv2();
        }, 10 * 1000);
      } else {
        // const resultDict = { chargingStatus: "CHARGE_NOW", doorLockState: "DOOR_LOCK" };
        // const idArray = id.split(".");
        // const stateName = idArray[idArray.length - 1];
        const vin = id.split(".")[2];
        // if (resultDict[stateName]) {
        //     let value = true;
        //     if (!state.val || state.val === "INVALID" || state.val === "NOT_CHARGING" || state.val === "ERROR" || state.val === "UNLOCKED") {
        //         value = false;
        //     }
        //     await this.setStateAsync(vin + ".remote." + resultDict[stateName], value, true);
        // }

        if (id.indexOf(".chargingStatus") !== -1 && state.val !== "CHARGING") {
          await this.setObjectNotExistsAsync(vin + ".status.chargingTimeRemaining", {
            type: "state",
            common: {
              name: "chargingTimeRemaining",
              role: "value",
              type: "number",
              write: false,
              read: true,
            },
            native: {},
          });
          this.setState(vin + ".status.chargingTimeRemaining", 0, true);
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
