/** Fixed ports for the live stack; global setup refuses to start if either is taken. */
const apiPort = 8798;
const webPort = 3218;

export const LIVE = {
  apiPort,
  webPort,
  apiUrl: `http://localhost:${apiPort}`,
  webUrl: `http://localhost:${webPort}`,
};
