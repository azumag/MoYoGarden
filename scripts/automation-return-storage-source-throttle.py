from pathlib import Path

path = Path("src/autonomy-region.ts")
text = path.read_text()
old = '''    const keepReturnStorageReservation =
      claim.returnToSourceStorage === true
      && (claim.returnStorageAmount ?? claim.amount) > 0;
    const next = remainingAmount > 0 || keepReturnStorageReservation
      ? claims.map((entry) => entry.claimId === claim.claimId
        ? {
            ...entry,
            amount: remainingAmount,
            settledAmount,
            ...(keepReturnStorageReservation
              ? {
                  returnStorageAmount: claim.returnStorageAmount ?? claim.amount,
                  returnStorageLeaseExpiresAtMs: Date.now() + RETURN_STORAGE_RESERVATION_TTL_MS,
                  expiresAtTick: Math.max(claim.expiresAtTick, tick + AUTONOMOUS_SUPPLY_CLAIM_TTL),
                }
              : {}),
          }
        : entry)
      : claims.filter((entry) => entry.claimId !== claim.claimId);
'''
new = '''    const keepReturnStorageReservation =
      claim.returnToSourceStorage === true
      && (claim.returnStorageAmount ?? claim.amount) > 0;
    const nowMs = Date.now();
    const shouldRenewReturnStorageLease =
      keepReturnStorageReservation
      && (
        claim.returnStorageLeaseExpiresAtMs === undefined
        || claim.returnStorageLeaseExpiresAtMs
          <= nowMs + RETURN_STORAGE_RESERVATION_TTL_MS - RETURN_STORAGE_RENEW_INTERVAL_MS
      );
    const next = remainingAmount > 0 || keepReturnStorageReservation
      ? claims.map((entry) => entry.claimId === claim.claimId
        ? {
            ...entry,
            amount: remainingAmount,
            settledAmount,
            ...(keepReturnStorageReservation
              ? {
                  returnStorageAmount: claim.returnStorageAmount ?? claim.amount,
                  returnStorageLeaseExpiresAtMs: shouldRenewReturnStorageLease
                    ? nowMs + RETURN_STORAGE_RESERVATION_TTL_MS
                    : claim.returnStorageLeaseExpiresAtMs,
                  expiresAtTick: Math.max(claim.expiresAtTick, tick + AUTONOMOUS_SUPPLY_CLAIM_TTL),
                }
              : {}),
          }
        : entry)
      : claims.filter((entry) => entry.claimId !== claim.claimId);
'''
count = text.count(old)
assert count == 1, f"expected one source settlement lease block, got {count}"
path.write_text(text.replace(old, new, 1))
