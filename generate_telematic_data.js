/**
 * Generate descriptions and states from telematic.json
 * This method creates this.description and this.states objects for use in the BMW adapter
 */

const fs = require('fs');
const path = require('path');

/**
 * Generate descriptions and states from telematic.json file
 * @returns {Object} Object containing descriptions and states
 */
function generateTelematicData() {
  try {
    // Read telematic.json file
    const telematicPath = path.join(__dirname, 'telematic.json');

    if (!fs.existsSync(telematicPath)) {
      console.error('telematic.json file not found');
      return { descriptions: {}, states: {} };
    }

    const telematicData = JSON.parse(fs.readFileSync(telematicPath, 'utf8'));

    const descriptions = {};
    const states = {};

    // Process each entry in telematic.json
    telematicData.forEach(item => {
      if (item.technical_identifier && item.cardata_element) {
        // Generate description: technical_identifier: 'cardata_element'
        descriptions[item.technical_identifier] = item.cardata_element;

        // Generate states: technical_identifier: typical_value_range (if array)
        if (item.typical_value_range && Array.isArray(item.typical_value_range)) {
          states[item.technical_identifier] = item.typical_value_range;
        }
      }
    });

    console.log(`Generated ${Object.keys(descriptions).length} descriptions`);
    console.log(`Generated ${Object.keys(states).length} states with value ranges`);

    return { descriptions, states };
  } catch (error) {
    console.error(`Error generating telematic data: ${error.message}`);
    return { descriptions: {}, states: {} };
  }
}

// Export for use in other modules
module.exports = { generateTelematicData };

// If run directly, output the generated data
if (require.main === module) {
  const { descriptions, states } = generateTelematicData();

  console.log('\n=== DESCRIPTIONS ===');
  console.log('this.description = {');
  Object.entries(descriptions).forEach(([key, value]) => {
    console.log(`  '${key}': '${value}',`);
  });
  console.log('};');

  console.log('\n=== STATES ===');
  console.log('this.states = {');
  Object.entries(states).forEach(([key, value]) => {
    console.log(`  '${key}': ${JSON.stringify(value)},`);
  });
  console.log('};');
}
