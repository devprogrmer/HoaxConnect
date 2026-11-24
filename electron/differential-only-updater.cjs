function differentialOnlyUpdater(NsisUpdater) {
  return class extends NsisUpdater {
    doDownloadUpdate(options) {
      return super.doDownloadUpdate({
        ...options,
        disableWebInstaller: true,
        disableDifferentialDownload: false,
      });
    }

    async differentialDownloadInstaller(...args) {
      // electron-updater returns true when it would fall back to a full download.
      if (await super.differentialDownloadInstaller(...args) !== false) {
        const error = new Error(
          "The small update could not be applied to this installation. No full installer was downloaded."
        );
        error.code = "ERR_HOAX_DIFFERENTIAL_UNAVAILABLE";
        throw error;
      }
      return false;
    }
  };
}

module.exports = { differentialOnlyUpdater };
