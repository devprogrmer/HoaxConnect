const {
  app,
} = require("electron");

const fs = require("fs");
const path = require("path");

const DEFAULT_STATE = {
  mode: "selected-only",

  selectedApps: [],

  updatedAt: null,
};

function storePath() {
  return path.join(
    app.getPath("userData"),
    "split-tunnel.json"
  );
}

function normalizeState(input) {
  const allowedModes = new Set([
    "selected-only",
    "all",
    "exclude-selected",
  ]);

  const mode =
    allowedModes.has(input?.mode)
      ? input.mode
      : DEFAULT_STATE.mode;

  const selectedApps =
    Array.isArray(
      input?.selectedApps
    )
      ? input.selectedApps
          .filter(
            (item) =>
              item &&
              typeof item.id ===
                "string" &&
              typeof item.path ===
                "string"
          )
          .map((item) => ({
            id: item.id,

            name:
              String(
                item.name || ""
              ),

            exeName:
              String(
                item.exeName || ""
              ),

            path:
              String(item.path),

            source:
              String(
                item.source || ""
              ),
          }))
      : [];

  return {
    mode,

    selectedApps,

    updatedAt:
      input?.updatedAt || null,
  };
}

function readState() {
  const file = storePath();

  try {
    if (!fs.existsSync(file)) {
      return {
        ...DEFAULT_STATE,
      };
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          file,
          "utf8"
        )
      );

    return normalizeState(parsed);
  } catch {
    return {
      ...DEFAULT_STATE,
    };
  }
}

function writeState(input) {
  const state =
    normalizeState(input);

  state.updatedAt =
    new Date().toISOString();

  const file = storePath();

  fs.mkdirSync(
    path.dirname(file),
    {
      recursive: true,
    }
  );

  const tmp =
    `${file}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(
      state,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    tmp,
    file
  );

  return state;
}

module.exports = {
  readState,
  writeState,
};
