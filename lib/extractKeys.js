//v3.0
const JSONbig = require("json-bigint")({ storeAsString: true });
const alreadyCreatedOBjects = {};
async function extractKeys(adapter, path, element, preferedArrayName, forceIndex, write, channelName) {
    try {
        if (element === null || element === undefined) {
            adapter.log.debug("Cannot extract empty: " + path);
            return;
        }

        const objectKeys = Object.keys(element);

        if (!write) {
            write = false;
        }

        if (typeof element === "string" || typeof element === "number") {
            let name = element;
            if (typeof element === "number") {
                name = element.toString();
            }
            if (!alreadyCreatedOBjects[path]) {
                await adapter
                    .setObjectNotExistsAsync(path, {
                        type: "state",
                        common: {
                            name: name,
                            role: getRole(element, write),
                            type: typeof element,
                            write: write,
                            read: true,
                        },
                        native: {},
                    })
                    .then(() => {
                        alreadyCreatedOBjects[path] = true;
                    })
                    .catch((error) => {
                        adapter.log.error(error);
                    });
            }

            adapter.setState(path, element, true);
            return;
        }
        if (!alreadyCreatedOBjects[path]) {
            await adapter
                .setObjectNotExistsAsync(path, {
                    type: "channel",
                    common: {
                        name: channelName || "",
                        write: false,
                        read: true,
                    },
                    native: {},
                })
                .then(() => {
                    alreadyCreatedOBjects[path] = true;
                })
                .catch((error) => {
                    adapter.log.error(error);
                });
        }
        if (Array.isArray(element)) {
            extractArray(adapter, element, "", path, write, preferedArrayName, forceIndex);
            return;
        }
        objectKeys.forEach(async (key) => {
            if (isJsonString(element[key])) {
                element[key] = JSONbig.parse(element[key]);
            }

            if (Array.isArray(element[key])) {
                extractArray(adapter, element, key, path, write, preferedArrayName, forceIndex);
            } else if (element[key] !== null && typeof element[key] === "object") {
                extractKeys(adapter, path + "." + key, element[key], preferedArrayName, forceIndex, write);
            } else {
                if (!alreadyCreatedOBjects[path + "." + key]) {
                    await adapter
                        .setObjectNotExistsAsync(path + "." + key, {
                            type: "state",
                            common: {
                                name: key,
                                role: getRole(element[key], write),
                                type: typeof element[key],
                                write: write,
                                read: true,
                            },
                            native: {},
                        })
                        .then(() => {
                            if (description[key]) {
                                adapter.extendObject(path + "." + key, {
                                    type: "state",
                                    common: {
                                        name: description[key],
                                        role: getRole(element[key], write),
                                        type: typeof element[key],
                                        write: write,
                                        read: true,
                                    },
                                    native: {},
                                });
                            }
                            alreadyCreatedOBjects[path + "." + key] = true;
                        })
                        .catch((error) => {
                            adapter.log.error(error);
                        });
                }
                adapter.setState(path + "." + key, element[key], true);
            }
        });
    } catch (error) {
        adapter.log.error("Error extract keys: " + path + " " + JSON.stringify(element));
        adapter.log.error(error);
    }
}
function extractArray(adapter, element, key, path, write, preferedArrayName, forceIndex) {
    try {
        if (key) {
            element = element[key];
        }
        element.forEach(async (arrayElement, index) => {
            index = index + 1;
            if (index < 10) {
                index = "0" + index;
            }
            let arrayPath = key + index;
            if (typeof arrayElement === "string") {
                extractKeys(adapter, path + "." + key + "." + arrayElement, arrayElement, preferedArrayName, forceIndex, write);
                return;
            }
            if (typeof arrayElement[Object.keys(arrayElement)[0]] === "string") {
                arrayPath = arrayElement[Object.keys(arrayElement)[0]];
            }
            Object.keys(arrayElement).forEach((keyName) => {
                if (keyName.endsWith("Id") && arrayElement[keyName] !== null) {
                    if (arrayElement[keyName] && arrayElement[keyName].replace) {
                        arrayPath = arrayElement[keyName].replace(/\./g, "");
                    } else {
                        arrayPath = arrayElement[keyName];
                    }
                }
            });
            Object.keys(arrayElement).forEach((keyName) => {
                if (keyName.endsWith("Name")) {
                    arrayPath = arrayElement[keyName];
                }
            });

            if (arrayElement.id) {
                if (arrayElement.id.replace) {
                    arrayPath = arrayElement.id.replace(/\./g, "");
                } else {
                    arrayPath = arrayElement.id;
                }
            }
            if (arrayElement.name) {
                arrayPath = arrayElement.name.replace(/\./g, "");
            }
            if (arrayElement.start_date_time) {
                arrayPath = arrayElement.start_date_time.replace(/\./g, "");
            }
            if (preferedArrayName && arrayElement[preferedArrayName]) {
                arrayPath = arrayElement[preferedArrayName].replace(/\./g, "");
            }

            if (forceIndex) {
                arrayPath = key + index;
            }
            //special case array with 2 string objects
            if (
                Object.keys(arrayElement).length === 2 &&
                typeof Object.keys(arrayElement)[0] === "string" &&
                typeof Object.keys(arrayElement)[1] === "string" &&
                typeof arrayElement[Object.keys(arrayElement)[0]] !== "object" &&
                typeof arrayElement[Object.keys(arrayElement)[1]] !== "object" &&
                arrayElement[Object.keys(arrayElement)[0]] !== "null"
            ) {
                let subKey = arrayElement[Object.keys(arrayElement)[0]];
                const subValue = arrayElement[Object.keys(arrayElement)[1]];
                const subName = Object.keys(arrayElement)[0] + " " + Object.keys(arrayElement)[1];
                if (key) {
                    subKey = key + "." + subKey;
                }
                if (!alreadyCreatedOBjects[path + "." + subKey]) {
                    await adapter
                        .setObjectNotExistsAsync(path + "." + subKey, {
                            type: "state",
                            common: {
                                name: subName,
                                role: getRole(subValue, write),
                                type: typeof subValue,
                                write: write,
                                read: true,
                            },
                            native: {},
                        })
                        .then(() => {
                            alreadyCreatedOBjects[path + "." + subKey] = true;
                        });
                }
                adapter.setState(path + "." + subKey, subValue, true);
                return;
            }
            extractKeys(adapter, path + "." + arrayPath, arrayElement, preferedArrayName, forceIndex, write);
        });
    } catch (error) {
        adapter.log.error("Cannot extract array " + path);
        adapter.log.error(error);
    }
}
function isJsonString(str) {
    try {
        JSON.parse(str);
    } catch (e) {
        return false;
    }
    return true;
}
function getRole(element, write) {
    if (typeof element === "boolean" && !write) {
        return "indicator";
    }
    if (typeof element === "boolean" && write) {
        return "switch";
    }
    if (typeof element === "number" && !write) {
        return "value";
    }
    if (typeof element === "number" && write) {
        return "level";
    }
    if (typeof element === "string") {
        return "text";
    }
    return "state";
}
const description = {
    allTrips: "alle Fahrten des Autos",
    avgCombinedConsumption: "Durchschnittlicher kombinierter Verbrauch",
    communityAverage: "Gesamt Durchschnitt",
    communityHigh: "Gesamt max.",
    communityLow: "Gesamt min.",
    userAverage: "Fahrer Durchschnitt",
    avgElectricConsumption: "Durchschnittlicher elektrischer Verbrauch",
    avgRecuperation: "Durchschnittliche Rekuperation",
    chargecycleRange: "Ladezyklus Reichweite",
    userCurrentChargeCycle: "aktueller Ladezyklus",
    userHigh: "Fahrer max.",
    totalElectricDistance: "gesamte elektrische Distanz",
    batterySizeMax: "max. Batterie Ladeleistung in Wh",
    resetDate: "Werte zur+ckgesetz am",
    savedCO2: "Eingespartes CO2",
    savedCO2greenEnergy: "Eingespartes CO2 grüne Energie",
    totalSavedFuel: "Gesamt gesparter Kraftstoff",
    apiV2: "limitierte v2 Api des Autos",
    basicType: "Grundtyp",
    bodyType: "Fahrzeugtyp",
    brand: "Marke",
    modelName: "Model Name",
    series: "Serie",
    vin: "Fahrzeugidentifikationsnummer",
    chargingprofile: "Ladeprofil",
    overrideTimer: "Einmalige Abfahrtszeit",
    weekdays: "Wochentag",
    departureTime: "Abfahrtszeit",
    timerEnabled: "Timer Aktiviert",
    preferredChargingWindow: "Tägliches Ladefenster",
    endTime: "Ende Uhrzeit",
    startTime: "Start Uhrzeit",
    MONDAY: "Montag",
    TUESDAY: "Dienstag",
    WEDNESDAY: "Mittwoch",
    THURSDAY: "Donnerstag",
    FRIDAY: "Freitag",
    SATURDAY: "Samstag",
    SUNDAY: "Sonntag",
    chargingMode: "Lademodus",
    chargingPreferences: "Ladeeinstellungen",
    climatizationEnabled: "Klimatisierung Aktiviert",
    general: "Allgemeine Fahrzeuginformationen",
    dealer: "Händler",
    city: "Stadt",
    country: "Land",
    phone: "Telefon",
    postalCode: "Postleitzahl",
    street: "Straße",
    supportedChargingModes: "unterstützte Lademodi",
    accelerationValue: "Beschleunigungs Wert",
    anticipationValue: "Erwartungswert",
    auxiliaryConsumptionValue: "Hilfsverbrauchswert",
    date: "Datum",
    drivingModeValue: "Fahrmodus",
    duration: "Dauer",
    efficiencyValue: "Effizienz Wert",
    electricDistance: "elektrische Distanz",
    electricDistanceRatio: "elektrisches Distanzverhältnis in %",
    savedFuel: "Eingesparter Kraftstoff",
    totalConsumptionValue: "Gesamtverbrauchswert",
    totalDistance: "Gesamtstrecke",
    rangemap: "Reichweitenkarte",
    center: "Mitte",
    remote: "Fernbedienung",
    CHARGE_NOW: "jetzt Aufladen",
    CLIMATE_NOW: "Klimatisierung starten",
    DOOR_LOCK: "Autotüren zusperren",
    DOOR_UNLOCK: "Autotüren aufsperren",
    GET_VEHICLES: "Fahrzeuginformationen abrufen",
    GET_VEHICLE_STATUS: "Fahrzeug Status abrufen",
    HORN_BLOW: "Hupe einschalten",
    LIGHT_FLASH: "Lichthupe einschalten",
    START_CHARGING: "Laden starten",
    START_PRECONDITIONING: "Startvoraussetzung",
    STOP_CHARGING: "Laden stoppen",
    VEHICLE_FINDER: "Positionsdaten Fahrzeug abrufen",
    serviceExecutionHistory: "Verlauf der Remote-Ausführung",
    status: "Aktueller Status",
    BRAKE_FLUID: "Bremsflüssigkeit",
    cbsDescription: "Service Beschreibung",
    cbsDueDate: "Service Fälligkeitsdatum",
    cbsState: "Service Status",
    cbsType: "Service Art",
    VEHICLE_CHECK: "Fahrzeug Überprüfung",
    position: "Position",
    heading: "Richtung",
    lat: "Latitude",
    lon: "Longitude",
    DCS_CCH_Activation: "DCS CCH Aktivierung",
    DCS_CCH_Ongoing: "DCS CHH Laufend",
    chargingConnectionType: "Ladeverbindungstyp",
    chargingInductivePositioning: "Aufladen Induktive Positionierung",
    chargingLevelHv: "Batterie SoC in %",
    chargingStatus: "Ladestatus",
    chargingTimeRemaining: "Verbleibende Ladezeit",
    connectionStatus: "Verbindungsstatus Ladestecker",
    doorDriverFront: "Fahrertüren",
    driverFront: "Fahrertüren",
    doorDriverRear: "Hintere Türe Fahrerseite",
    doorLockState: "Fahrzeug Verriegelungszustand Türen und Fenster",
    doorPassengerFront: "Beifahrertüre",
    doorPassengerRear: "Hintere Türe Beifahrerseite",
    hood: "Motorhaube",
    internalDataTimeUTC: "Fahrzeugzeit UTC",
    lastChargingEndReason: "letzter Grund für das Ende des Ladevorgangs",
    lastChargingEndResult: "letztes Ladeendergebnis",
    maxRangeElectric: "max. elektrische Reichweite in km",
    maxRangeElectricMls: "max. elektrische Reichweite in mi",
    mileage: "Kilometerstand",
    remainingFuel: "Tankinhalt",
    remainingRangeElectric: "restliche Reichweite Elektrisch in km",
    remainingRangeElectricMls: "restliche Reichweite Elektrisch in mi",
    remainingRangeFuel: "restliche Reichweite Kraftstoff in km",
    remainingRangeFuelMls: "restliche Reichweite Kraftstoff in mi",
    singleImmediateCharging: "einmalige Sofortaufladung",
    trunk: "Kofferraum",
    updateReason: "Aktualisierungsgrund",
    updateTime: "Aktualisierungszeit",
    vehicleCountry: "Fahrzeug Land",
    windowDriverFront: "Fenster Fahrerseite",
    windowPassengerFront: "Fenster Beifahrerseite",
};
module.exports = {
    extractKeys,
};
