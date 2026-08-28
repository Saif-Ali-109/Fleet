import { loadSkill } from "../skills/loader.ts";
import {
	asRecord,
	asString,
	type ToolImpl,
	ToolInputError,
	type ToolResult,
} from "./common.ts";

export const loadSkillTool: ToolImpl = {
	schema: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "skill name within this role's skills dir",
			},
		},
		required: ["name"],
		additionalProperties: false,
	},
	async exec(input, ctx): Promise<ToolResult> {
		try {
			const name = asString(asRecord(input), "name");
			const loaded = loadSkill(ctx.role, name);
			return loaded.ok ? { ok: true, content: loaded.body } : loaded;
		} catch (err) {
			if (!(err instanceof ToolInputError)) throw err;
			return { ok: false, error: err.message };
		}
	},
};
