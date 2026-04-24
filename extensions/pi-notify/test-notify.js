import notifier from "node-notifier";

const title = process.argv[2] ?? "Pi notification test";
const message = process.argv[3] ?? "If you can read this, native notifications are working.";
const soundArg = process.argv[4];

const sound =
  soundArg === undefined
    ? true
    : ["0", "false", "no", "off"].includes(soundArg.toLowerCase())
      ? false
      : ["1", "true", "yes", "on"].includes(soundArg.toLowerCase())
        ? true
        : soundArg;

notifier.notify({
  title,
  message,
  sound,
  timeout: 10,
  wait: false,
  appID: "Pi",
});

console.log("Notification request sent.");
console.log(JSON.stringify({ title, message, sound }, null, 2));
