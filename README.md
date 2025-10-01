<img src="admin/bmw.png" alt="Logo" width="200">

# ioBroker.bmw

[![NPM version](https://img.shields.io/npm/v/iobroker.bmw.svg)](https://www.npmjs.com/package/iobroker.bmw)
[![Downloads](https://img.shields.io/npm/dm/iobroker.bmw.svg)](https://www.npmjs.com/package/iobroker.bmw)
![node-lts](https://img.shields.io/node/v-lts/iobroker.bmw?style=flat-square)
![Libraries.io dependency status for latest release](https://img.shields.io/librariesio/release/npm/iobroker.bmw?label=npm%20dependencies&style=flat-square)

![GitHub](https://img.shields.io/github/license/TA2k/iobroker.bmw?style=flat-square)
![GitHub repo size](https://img.shields.io/github/repo-size/TA2k/iobroker.bmw?logo=github&style=flat-square)
![GitHub commit activity](https://img.shields.io/github/commit-activity/m/TA2k/iobroker.bmw?logo=github&style=flat-square)
![GitHub last commit](https://img.shields.io/github/last-commit/TA2k/iobroker.bmw?logo=github&style=flat-square)
![GitHub issues](https://img.shields.io/github/issues/TA2k/iobroker.bmw?logo=github&style=flat-square)

![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/TA2k/iobroker.bmw/test-and-release.yml?branch=master&logo=github&style=flat-square)
[![SNYK Known Vulnerabilities](https://snyk.io/test/github/TA2k/ioBroker.bmw/badge.svg)](https://snyk.io/test/github/TA2k/ioBroker.bmw)

## Versions

![Beta](https://img.shields.io/npm/v/iobroker.bmw.svg?color=red&label=beta)
![Stable](https://iobroker.live/badges/bmw-stable.svg)
![Installed](https://iobroker.live/badges/bmw-installed.svg)

[![NPM](https://nodei.co/npm/iobroker.bmw.png?downloads=true)](https://nodei.co/npm/iobroker.bmw/)

# BMW Adapter for ioBroker

This adapter integrates BMW vehicles into ioBroker using the new BMW CarData API with OAuth2 authentication and real-time MQTT streaming. It provides comprehensive vehicle data monitoring for all BMW models linked to your BMW account.

## Features

- **OAuth2 Device Flow Authentication** - Secure authentication without storing credentials
- **Real-time MQTT Streaming** - Instant updates when vehicle data changes
- **Comprehensive Data Coverage** - Access to all CarData API endpoints including:
  - Basic vehicle information
  - Charging history and sessions
  - Trip data and efficiency metrics
  - Service demands and vehicle status
  - Location and navigation data
- **API Quota Management** - Intelligent handling of 50 API calls per 24-hour limit
- **Automatic State Cleanup** - Removes old vehicle data when vehicles are no longer available

## ⚠️ Breaking Changes in v4.0

**REMOVED:**

- Username/password login (replaced with OAuth2)
- All remote controls (lock/unlock, climate, charging) - CarData API is read-only
- Second user support
- CAPTCHA requirements

**ADDED:**

- OAuth2 Device Flow authentication
- Real-time MQTT streaming
- 50 API calls per 24h quota management
- Comprehensive data from all CarData endpoints

## Setup Instructions

### 1. BMW ConnectedDrive Portal Setup

1. Visit the BMW ConnectedDrive portal: **https://www.bmw.de/de-de/mybmw/vehicle-overview**
2. Navigate to the **CarData** section
3. Generate a new **Client ID**
4. **Subscribe to both services:**
   - CarData API
   - CarData Streaming
     **CRITICAL**: Click one service and wait 20seconds if you see a error message click again

### 2. ⚠️ CRITICAL: Data Descriptors Configuration

**YOU MUST MANUALLY SELECT ALL 244 DATA POINTS**

After creating your Client ID:

1. Go to **CarData > Data Descriptors**
2. **Select ALL categories** (Vehicle Status, Charging, Trip Data, etc.)
3. **Manually check ALL 244 individual data points**
4. Save your configuration

**Without selecting all data points, MQTT streaming will not provide complete data!**

### 3. Adapter Configuration

1. Enter your **Client ID** in the adapter settings
2. Enter your **CarData Streaming Username** (found in BMW portal under CarData > Streaming section)
3. Select your vehicle **brand** (BMW, Mini, Toyota Supra)
4. Set **update interval** (minimum 10 minutes due to API quota)
5. **Configure API Endpoints** - Select which data to fetch:
   - **Basic Data** ✅ - Essential vehicle information (recommended)
   - **Charging History** ✅ - Charging sessions and history (recommended)
   - **Vehicle State** ✅ - Current vehicle status (recommended)
   - **Charging Profile** - Charging preferences and profiles
   - **Charging Sessions** - Detailed charging session data
   - **Climate Now** - Current climate control status
   - **Destination Information** - Navigation and destination data
   - **Location** - GPS position and location services
   - **Statistics** - Driving statistics and analytics
6. Configure **VIN ignore list** if needed

**💡 Tip:** Only enable endpoints you actually need to conserve your 50 API calls per 24-hour quota. MQTT streaming provides real-time data without using quota.

### 4. Authentication Process

1. Start the adapter
2. Check the logs for the OAuth2 authorization URL
3. Visit the URL and login with your BMW account
4. Authorize the application
5. The adapter will automatically continue after authorization

## Data Structure

Vehicle data is organized under `bmw.0.VIN.*` where `VIN` represents your Vehicle Identification Number:

### Main Folder Structure

- **`bmw.0.VIN.api.*`** - API Data (Periodic Updates)

  - Data fetched via BMW CarData REST API
  - Uses API quota (50 calls per 24 hours)
  - Updated based on configured interval
  - Only includes endpoints you've enabled in settings

- **`bmw.0.VIN.stream.*`** - Stream Data (Real-time MQTT)
  - Data received via real-time MQTT streaming
  - No API quota consumption
  - Instant updates when vehicle data changes
  - Includes all 244 configured data points

### Available API Endpoints (Configurable)

You can enable/disable these endpoints in adapter settings:

- `bmw.0.VIN.api.basicData.*` - Vehicle information, model, brand, series ✅ **(Default: Enabled)**
- `bmw.0.VIN.api.chargingHistory.*` - Charging sessions and history ✅ **(Default: Enabled)**
- `bmw.0.VIN.api.chargingProfile.*` - Charging preferences and profiles
- `bmw.0.VIN.api.chargingSessions.*` - Detailed charging session data
- `bmw.0.VIN.api.climateNow.*` - Climate control status
- `bmw.0.VIN.api.destinationInformation.*` - Navigation and destination data
- `bmw.0.VIN.api.location.*` - GPS position and location services
- `bmw.0.VIN.api.statistics.*` - Driving statistics and analytics
- `bmw.0.VIN.api.vehicleState.*` - Current vehicle status and conditions ✅ **(Default: Enabled)**

### Metadata

- `bmw.0.VIN.lastUpdate` - Timestamp of last data update (API or MQTT)
- `bmw.0.VIN.lastStreamUpdate` - Timestamp of last MQTT stream update

## Real-time Updates

The adapter receives real-time updates via MQTT streaming when:

- Vehicle status changes (doors, windows, lights)
- Charging status updates
- Location changes during driving
- Climate control activation
- Service notifications

## Remote Commands

⚠️ **Remote controls have been removed in v4.0** as the BMW CarData API is read-only and does not support vehicle commands. For remote control functionality, you would need to use BMW's official mobile app.

## Troubleshooting

### Authentication Issues (400 Bad Request)

If you encounter authentication errors:

1. Verify CarData API is activated for your Client ID
2. Ensure CarData Streaming is enabled
3. Check that all 244 data points are selected
4. Consider regenerating your Client ID

### No MQTT Data

If you're not receiving real-time updates:

1. Verify CarData Streaming is subscribed and active
2. Ensure all data descriptors (244 points) are selected
3. Check that your vehicle supports CarData streaming
4. Restart the adapter after descriptor configuration changes

### API Quota Exceeded

The adapter manages the 50 API calls per 24-hour limit automatically:

- **Disable unnecessary API endpoints** in adapter settings to reduce quota usage
- Increase update interval if you hit quota limits frequently
- MQTT streaming doesn't count against API quota and provides real-time data
- Each enabled API endpoint uses one quota call per update interval

### Missing Data in API Folder

If you're not seeing expected data in `VIN.api.*`:

1. Check if the corresponding endpoint is enabled in adapter settings
2. Verify you haven't exceeded API quota (check adapter logs)
3. Some endpoints may not be available for all vehicle types
4. Check adapter logs for specific endpoint errors (404, 403, etc.)

### Understanding Data Sources

- **`VIN.api.*`** - Updated periodically based on interval and enabled endpoints
- **`VIN.stream.*`** - Updated in real-time via MQTT when vehicle data changes
- **`VIN.lastUpdate`** - Timestamp of most recent data update (API or MQTT)
- **`VIN.lastStreamUpdate`** - Timestamp of most recent MQTT stream update

## Source

This adapter is available at: [https://github.com/TA2k/ioBroker.bmw](https://github.com/TA2k/ioBroker.bmw)

## Changelog

### 4.0.0 (2025-10-01)

- **BREAKING:** Complete migration to BMW CarData API with OAuth2 Device Flow authentication
- **BREAKING:** Removed username/password authentication (deprecated by BMW)
- **BREAKING:** Removed all remote control functionality (CarData API is read-only)
- **BREAKING:** Removed second user support and CAPTCHA requirements
- **NEW:** Real-time MQTT streaming for instant vehicle data updates
- **NEW:** OAuth2 Device Code Flow authentication with PKCE
- **NEW:** API quota management system (50 calls per 24 hours)
- **NEW:** Configurable API endpoint selection to manage quota usage
- **NEW:** Organized folder structure: api/ for periodic updates, stream/ for real-time data
- **NEW:** Enhanced state management with proper object creation
- **NEW:** Modern JSON-based configuration interface (jsonConfig.json)
- **NEW:** Comprehensive setup documentation with BMW portal integration
- **FIXED:** MQTT message processing logic for correct data validation
- **FIXED:** State creation issues preventing "no existing object" errors
- **IMPROVED:** Removed unused dependencies (cookie handling, legacy auth)
- **IMPROVED:** Enhanced error handling with specific guidance for common issues

### 3.0.1 (2025-09-27)

- (hombach) change to recommended stable admin 7.6.17 (#159)
- (hombach) migrate to iobroker/eslint-config (#146)
- (hombach) fix form-data vulnerability
- (hombach) code cleanups
- (hombach) update axios
- (hombach) bump adapter-core
- (hombach) fix issues detected by repository checker (#170)
- (hombach) bump dependencies

### 3.0.0 (2025-06-10)

- BREAKING: Dropped support for Node.js 18 (#88)
- (hombach) BREAKING: Dropped support for js-controller 5 (#111)
- (hombach) BREAKING: change to admin 7.4.10 as recommended by ioBroker (#111)
- (hombach) encrypt and protect second user password - has to be reentered (#111)
- (hombach) bump dependencies

### 2.9.5 (2025-05-18)

- (hombach) update axios
- (hombach) fixing issues detected by repository checker (#88)
- (hombach) some small code cleanups/modernisations
- (hombach) add/translate description
- (hombach) update logo

### 2.9.4 (2025-02-26)

- fix for Mitbenutzer Feature

### 2.9.3 (2025-01-29)

- fix remote controls
- add Mitbenutzer Login for remote controls

### 2.9.0 (2024-11-28)

- added new remotes as switch and updated values
- added retry logic for remotes

### 2.8.4 (2024-11-21)

- improved charging session parsing
- added remote to fetch charging session from a specific month
- added raw JSON of charging session for export

### 2.8.3 (2024-11-18)

- login fixed

### 2.8.2 (2024-10-05)

- fix error getvehicles v2 failed

### 2.8.1 (2024-09-30)

- fix remote commands

### 2.7.1

- Bugfixes

### 2.5.5

- Fix login

### 2.5.0

- Fix login

### 2.4.1

- Add support for MINI and force refresh remote

### 2.3.0

- Disable v1 Endpoints

### 2.1.1

- Upgrade to statusV2 and remoteV2

### 2.0.0

- (TA2k) initial release

## License

MIT License

Copyright (c) 2021-2025 TA2k <tombox2020@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
