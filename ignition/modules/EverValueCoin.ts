import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const evaModule = buildModule("evaModule", (m) => {
  const eva = m.contract("EverValueCoin", [], {});

  return { eva };
});

export default evaModule;
