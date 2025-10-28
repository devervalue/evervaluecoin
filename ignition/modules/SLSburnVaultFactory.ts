import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const slsBurnVaultFactoryModule = buildModule("slsBurnVaultFactoryModule", (m) => {
  const addrEva = m.getParameter("addrEva");
  const addrBackingToken = m.getParameter("addrBackingToken");
  const addrBurnVault = m.getParameter("addrBurnVault");
  
  const slsBurnVaultFactory = m.contract("SLSburnVaultFactory", [addrEva, addrBurnVault, addrBackingToken], {});

  return { slsBurnVaultFactory };
});

export default slsBurnVaultFactoryModule;


