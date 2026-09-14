import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";
//#region extensions/feishu/setup-entry.ts
var setup_entry_default = defineBundledChannelSetupEntry({
	importMetaUrl: import.meta.url,
	features: { legacyStateMigrations: true },
	plugin: {
		specifier: "./setup-api.js",
		exportName: "feishuPlugin"
	},
	legacyStateMigrations: {
		specifier: "./legacy-state-migrations-api.js",
		exportName: "detectFeishuLegacyStateMigrations"
	},
	secrets: {
		specifier: "./secret-contract-api.js",
		exportName: "channelSecrets"
	}
});
//#endregion
export { setup_entry_default as default };
