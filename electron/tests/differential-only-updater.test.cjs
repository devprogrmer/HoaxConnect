const assert = require("node:assert/strict");
const test = require("node:test");
const { NsisUpdater } = require("electron-updater");
const { differentialOnlyUpdater } = require("../differential-only-updater.cjs");

test("the installed updater exposes the NSIS differential hook", () => {
  assert.equal(typeof NsisUpdater.prototype.differentialDownloadInstaller, "function");
});

test("Windows updater fails before downloading a full installer", async () => {
  class FakeNsisUpdater {
    async differentialDownloadInstaller() { return this.requiresFullDownload; }
    async doDownloadUpdate(options) {
      assert.equal(options.disableWebInstaller, true);
      if (options.disableDifferentialDownload || await this.differentialDownloadInstaller()) {
        this.fullDownloads += 1;
      }
    }
  }
  const updater = new (differentialOnlyUpdater(FakeNsisUpdater))();
  updater.fullDownloads = 0;
  updater.requiresFullDownload = false;
  await updater.doDownloadUpdate({ disableDifferentialDownload: true });
  updater.requiresFullDownload = true;
  await assert.rejects(updater.doDownloadUpdate({}), {
    code: "ERR_HOAX_DIFFERENTIAL_UNAVAILABLE",
  });
  assert.equal(updater.fullDownloads, 0);
});
