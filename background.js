chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "open-options") chrome.runtime.openOptionsPage();
});
