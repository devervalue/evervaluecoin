// Constructor args for DemoEVALocker @ 0x2809238a28E408f22aA1D5039503C23d733cD4a3
const DAY = 86400;
module.exports = [
  "0xcEb13950FeE444ab6963A14CD564f8E8975b7F1F", // DMO (eva)
  "0x2ae51885BCAa0B350FB32Bcce0527ce0D5527058", // DWBTC (wbtc)
  "0xcafc1d8C49aEB1B59B130580C228053Caf18A7c9", // EVABurnVault (core)
  [1, 2, 4, 8, 0], // weights
  [90 * DAY, 180 * DAY, 365 * DAY, 730 * DAY, 730 * DAY], // durations
  [0, 0, 0, 0, 0], // curves (LINEAR)
  [true, true, true, true, false], // transferables
];
