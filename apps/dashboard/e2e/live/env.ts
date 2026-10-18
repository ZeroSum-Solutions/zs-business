/** Fixed ports for the live stack; global setup refuses to start if either is taken. */
const apiPort = 8798;
const webPort = 3218;

export const LIVE = {
  apiPort,
  webPort,
  // Loopback by address: "localhost" may resolve to ::1 or, through a hosts entry, elsewhere.
  apiUrl: `http://127.0.0.1:${apiPort}`,
  webUrl: `http://127.0.0.1:${webPort}`,
};
