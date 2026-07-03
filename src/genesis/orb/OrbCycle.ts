let entropy = Math.random();

if (ORB_FOUNDER_MODE.enabled) {
  if (ORB_FOUNDER_MODE.preferAction === "restructure") {
    entropy = entropy * 1.15;
  }
}
