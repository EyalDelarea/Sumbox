import type { MigrationBuilder } from "node-pg-migrate";

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn("user_preferences", { summary_command_trigger: { type: "text" } });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumn("user_preferences", "summary_command_trigger");
};
