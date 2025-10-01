// iobroker prettier configuration file
import prettierConfig from '@iobroker/eslint-config/prettier.config.mjs';

export default {
    ...prettierConfig,
    // uncomment next line if you prefer double quotes
    singleQuote: true,
	printWidth: 140,
	useTabs: false,
    tabWidth: 2,
}
