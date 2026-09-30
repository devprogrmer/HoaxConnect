function isTrustedAuthSender(event, mainWindow, isPackaged) {
  if (
    !event ||
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    return false;
  }

  let url;

  try {
    url = new URL(event.senderFrame.url);
  } catch {
    return false;
  }

  if (isPackaged) {
    return url.protocol === "file:";
  }

  return url.origin === "http://localhost:5173";
}

module.exports = {
  isTrustedAuthSender,
};
