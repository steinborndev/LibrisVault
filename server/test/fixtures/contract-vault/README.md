# contract-vault fixture

A vault carrying all four text contracts `server/src/pipeline/vault-contracts.ts` checks, in
the shapes the real vault writes them in, and nothing else. The tests copy it to a temp
directory and break exactly one contract per case, which is the only way to prove the probe
reports the RIGHT contract rather than just going red.

Written by hand from the shapes, never copied from the real vault (hard rule 7).
