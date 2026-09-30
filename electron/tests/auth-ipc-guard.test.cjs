const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isTrustedAuthSender,
} = require("../auth/ipc-guard.cjs");

function setup(url, { packaged = false, mainFrame = true, sameWindow = true } = {}) {
  const frame = { url };
  const webContents = { mainFrame: frame };
  const mainWindow = { webContents };

  return {
    event: {
      sender: sameWindow ? webContents : {},
      senderFrame: mainFrame ? frame : { url },
    },
    mainWindow,
    packaged,
  };
}

test("accepts the trusted development main frame", () => {
  const input = setup("http://localhost:5173/");
  assert.equal(
    isTrustedAuthSender(input.event, input.mainWindow, input.packaged),
    true
  );
});

test("rejects another WebContents and an iframe", () => {
  const foreignWindow = setup("http://localhost:5173/", {
    sameWindow: false,
  });
  const iframe = setup("http://localhost:5173/frame", {
    mainFrame: false,
  });

  assert.equal(
    isTrustedAuthSender(
      foreignWindow.event,
      foreignWindow.mainWindow,
      false
    ),
    false
  );
  assert.equal(
    isTrustedAuthSender(iframe.event, iframe.mainWindow, false),
    false
  );
});

test("rejects an untrusted development origin", () => {
  const input = setup("http://evil.example/");

  assert.equal(
    isTrustedAuthSender(input.event, input.mainWindow, false),
    false
  );
});

test("packaged app accepts file URLs and rejects network URLs", () => {
  const local = setup("file:///app/index.html", { packaged: true });
  const remote = setup("https://example.com/", { packaged: true });

  assert.equal(
    isTrustedAuthSender(local.event, local.mainWindow, true),
    true
  );
  assert.equal(
    isTrustedAuthSender(remote.event, remote.mainWindow, true),
    false
  );
});
