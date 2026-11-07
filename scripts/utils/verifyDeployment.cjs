async function verifyDeployment(hre, { address, constructorArguments = [], contract }) {
  const label = contract || "auto-detected contract";
  console.log(`Memverifikasi ${label} di ${address}...`);

  try {
    const indexingDelayMs = Number(process.env.VERIFY_INDEXING_DELAY_MS ?? 15000);
    if (!Number.isSafeInteger(indexingDelayMs) || indexingDelayMs < 0) {
      throw new Error("VERIFY_INDEXING_DELAY_MS harus berupa bilangan bulat nol atau lebih.");
    }
    if (indexingDelayMs > 0) {
      console.log(`Menunggu indexing explorer selama ${indexingDelayMs} ms...`);
      await new Promise((resolve) => setTimeout(resolve, indexingDelayMs));
    }
    await hre.run("verify:verify", {
      address,
      constructorArguments,
      ...(contract ? { contract } : {}),
    });
    console.log(`Terverifikasi: ${label} (${address})`);
  } catch (error) {
    const message = error?.message || String(error);
    if (/already verified/i.test(message)) {
      console.log(`Sudah terverifikasi: ${label} (${address})`);
      return;
    }

    throw new Error(`Verifikasi ${label} (${address}) gagal: ${message}`, { cause: error });
  }
}

module.exports = { verifyDeployment };
