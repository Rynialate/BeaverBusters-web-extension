// Port of benpinpop/urlscan-dashboard tests/test_wallet_validation.py (27 tests) to node:test,
// run against src/lib/wallets.js, plus tests for the port's documented additions (Base, Solana,
// TON) and a few extra Python-parity checks.
//
//   node --test tests/*.mjs     (or plain `node --test` from the repo root; Node 22 does not take a bare directory)
//
// Every case and assertion of the Python suite is kept, under the Python test's name. The Python
// suite builds some addresses with a seeded RNG (random.Random(1337)); those were produced once by
// running the Python helpers and are embedded below as literals, together with the Python
// reference's own outputs (validate_wallet(...).detail(), detect_chain(...), keccak256).
//
// Documented deviations of the JS port (asserted as such, not as failures):
//   * extra chains: base (EVM), sol, ton; so CHAINS / EVM_CHAINS and the 0x candidate list differ;
//   * detectChain's Base58 first-letter fallback applies only to strings of <= 35 characters, so
//     long Solana keys that start with 1/3/D/L/M/T/X are not claimed by btc/doge/...
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

await import(new URL('../src/lib/wallets.js', import.meta.url));
const W = globalThis.BBWallets;
const C = W.codecs;
const { DecodeError } = W;

// ------------------------------------------------------------------ helpers

const fromHex = h => Uint8Array.from(h.match(/../g) || [], b => parseInt(b, 16));
const ascii = s => Uint8Array.from(s, ch => ch.charCodeAt(0));
const joined = check => check.errors.join(' ');
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // Python codecs.B58_ALPHABET
const translate = (s, from, to) => [...s].map(ch => (from.includes(ch) ? to[from.indexOf(ch)] : ch)).join('');

const PY_EVM_CHAINS = ['eth', 'bsc', 'matic', 'arb', 'avax', 'op'];
const EVM_CHAINS = [...PY_EVM_CHAINS, 'base']; // documented addition: Base
const PY_CHAINS = ['btc', 'eth', 'trx', 'xrp', 'bsc', 'ltc', 'doge', 'bch', 'ada', 'dash', 'matic', 'arb', 'avax', 'op'];
const CHAIN_ADDITIONS = ['base', 'sol', 'ton'];

// Python detection -> what the JS port should return (0x candidates gain the documented "base").
const adjustDetection = d =>
  d && d.chain === 'eth' && JSON.stringify(d.candidates) === JSON.stringify(PY_EVM_CHAINS) ? { ...d, candidates: EVM_CHAINS } : d;
// The fields of a JS check that Python's WalletCheck.detail() has (JS also reports `checksum`).
const pyFields = c => ({
  chain: c.chain, input: c.input, valid: c.valid, canonical: c.canonical, key: c.key, format: c.format, errors: c.errors,
  detected: c.detected,
});

// ---- Embedded from the Python reference (generated once; see header) ----
// Addresses the Python suite builds with its seeded RNG (random.Random(1337)), in call order:
// VALID/INVALID/DETECTION at import, then 350 in test_every_generated_..., then one in
// XrpTests.test_dash_and_tron_... (unittest runs classes and methods in name order).
const SEEDED = {
  trx_0x41: "TT3inhfvXSFGUduQW892uPSfnn5VyENm8i",
  ltc_0x30: "Lgh8Qi8hWEF6PY6Tv6y2koLiL2CYbH7KZt",
  ltc_0x32: "M8WQyVconC1BbZggfsq8E7aES99zpJD1GT",
  ltc_segwit: "ltc1q27sjschpsyd5ek4jzhwfxncuajcuygm2cx4crw",
  doge_0x1e: "DMbdCxam2TcV98DLfbcpfmi57sSrca8HBp",
  dash_0x4c: "Xjhdw9WcsBicZy2zk9fEaTvugEWiNKPK8X",
  avax_x: "X-avax13nauw3cnc9jwxwnungd0km9k4zxngnskz2l8vq",
  trx_invalid_from_0x00: "1QD9ZeBSiRUtybsLsi8LhQqRso4QX53KA1",
  doge_invalid_typo: "DKjN45rmTjxsP4S2g9GijgFVRG3xBGrjJx",
  det_ltc_0x30: "LecPt32GnGCfgGdzRq1aNPqjvUxTkwKVAK",
  det_doge_0x1e: "DCLtWZNyAeVfSNifrab2To8ejPZzYSeZ8C",
  det_dash_0x4c: "XjHsjEfKBr1nusHDPXqnarMcoKckhs87ft",
  runtime_dash_0x4c: "Xr1mkpfeXdqiwP3rJbyfRqSBffWTknQU9o",
};

// test_every_generated_version_byte_starts_with_documented_letter: [version, letter, hash160 hex, Python b58(version)]
const GENERATED = [
  [0x41, "T", "fbbba60cb8a96e340d1fcdcb13cc0014dee92aa4", "TYvFQGG7tFdR8rfsQWwmNxdcrSiFrn1MJx"],
  [0x30, "L", "e56d2debb9be104a4a3774d153456787c5f7ad23", "Lg93o4Laq174bk6Cuhk2ARbcnQ8o7VKWmx"],
  [0x32, "M", "bf6e53f1892b8ff7834d37684a534d16011c79b4", "MRMMTnbeRchfdRSaicLzz2ALBM8tZfNVYA"],
  [0x1e, "D", "3f9e6620d8c1ce2e665eb86e1d7c3397a292a594", "DAwUs6Thcn4bdiGzWw8DWH1YuHxFWcKSsp"],
  [0x4c, "X", "1682d7a4ae2d898d11a51947dbfeffaf56c00ae1", "XcjsSZSEfmGdFs5WCiHxrSmEFtZZD46xSZ"],
  [0x00, "1", "2561c49e6afad0e741c8c1c65b2785a942808a80", "14Qf899HCBHWFbD7g6b6MtZra53eda3PNJ"],
  [0x05, "3", "36335f42b2d3423e4ec6b1de089b2fc5c6ea0f34", "36dbxJKhVm7NSZ2LU5PTY6hHLxwtcqwTvA"],
  [0x41, "T", "1f784e76220d1c170da24eaf7e989baf9dcaad5b", "TCqc53h65tnpgDoAmxCfHCKyM5aoxYhK1G"],
  [0x30, "L", "10ca33dfd8cc75e42477025dce88ae83e75a2300", "LLkjJZsnVv7t7maNoXsDq5kiZZE5RiKZfe"],
  [0x32, "M", "86a0e00e9271f4c938b319067687e990e05e0da0", "MLB1VwaiTDQnf9dkj7VCN11UdjqbEEffPC"],
  [0x1e, "D", "ecce1278f75ff58d9853f19dcaeed5de104aae37", "DSjCsg6vX3ngsxHF1MtbzVkC2BB16Kfpp3"],
  [0x4c, "X", "c7af367d74bc8756e370a937fe9f2311396d7562", "XttgCRu3xiGjWNP3BkwCAd5kg1kjHfc9GU"],
  [0x00, "1", "dfd2301108477405b7fa196622a643ad8aa0ea83", "1MQTUt2YJTWH9C4VaP4aMezTkt3nsaaYLU"],
  [0x05, "3", "35e2923a1410678f8d2b40744c573147b9892655", "36bwA9s5pgiwywS8Cxy9N6xzzD9aDfPv1R"],
  [0x41, "T", "88d180db0cdc628dff9d87c23c835da1aafdea42", "TNSdshHTGeKMJHrVhAMVBvzoaxL5iutfd5"],
  [0x30, "L", "dd8fe04392bc1ba0f82788489e985689c15eab7b", "LfRTxHjtnTcocgz93FpkToFGZoPSsTnJV2"],
  [0x32, "M", "b2a507bee676abf5d1764175b683684999f5cf19", "MQBkD5YsZ8j8wkK9N9fNbf1h7TCfXPKrMa"],
  [0x1e, "D", "8397a70d57a33da71a4d2e6bff61bfd257776d7d", "DH8tjPgjmfNmFSPysdJLWLoskuPa618qgY"],
  [0x4c, "X", "0ab35ffbab3b9c3893cb12e98cf7d6a29a7141f2", "XbfRUMsYJ5FsUeDndLDwAjehXyuhxqT45i"],
  [0x00, "1", "9ada0be6add0c3b1f023fe8733f3afb01872e7d5", "1F7nGgJACpmUo6hAhttBw7QnzCZNaojZSv"],
  [0x05, "3", "37302b3c6cf3cbe7a67da5922ca3f5730f004231", "36ipnvkoiYdXBwytZnG4rhPrLtSMaco48h"],
  [0x41, "T", "b5678ab485cf495a850677da9f0a2cffde7db3d1", "TSWPLzUvsJ7kThThjvueZxUc8kq3EmCz5X"],
  [0x30, "L", "ab77a464265d77a53931d22d4250a312647dd16d", "Larb8u4yqPyjn18t2QKkNbiKktFfavpH3k"],
  [0x32, "M", "c5397c7172a1ba9b79f3a62c1321d2e32a0d39bb", "MRszDRdUpre4xHsRDAQGXUsPBMfvFHY1LY"],
  [0x1e, "D", "54e5e9d18d04016fa177af0ff44670802a4b9949", "DCszj2p8NtWdZszPoDddqhgGVfxKbDc7i8"],
  [0x4c, "X", "df86d1fdb70e2d4371077fc012755385577c8cfc", "Xw4k2WTiNvka2camdnYZKR3zbcLHNAYTae"],
  [0x00, "1", "6c1a8aa0f7f10ecde0a3318493262591e78b8c14", "1ArbmraKkSDEFyLXcRMPKwL2j5q57SjLzP"],
  [0x05, "3", "c6686167123b7d868483aa5b67e2fb4529483433", "3Kn6m1UY2EHD1rwC9nK7SXgbJ1w9unPfcd"],
  [0x41, "T", "deee1bce24bc02d91ec71cc673dba58482a363ed", "TWHxFipkXzAziyMLDkcaRvLsY569vtfbHA"],
  [0x30, "L", "145a49a4e37311253c105846c0afb13b74e5ddda", "LM5ZwM5nixDYXqcoSoR7eFnCNyWJrhWntL"],
  [0x32, "M", "9cc25d7aae49bc896c9966ae45a1eadc2379688c", "MNC2V5nao59BXdZ1hR5gm5RBQ5f1jkPC5A"],
  [0x1e, "D", "5cce8e6db87140d16fd422de6ae353eb1f030be0", "DDbp9hEPk1oWnJF64mMfwpPvwJXw3zDYZ6"],
  [0x4c, "X", "8bdf418a795dae41a09791fcbfb4870d89b28ff9", "XoSRD1zyADjPs1LemPk9wgqB9WT7wyXPUh"],
  [0x00, "1", "466fc64a47227a367aa0a8d8b657699e0799b487", "17RSCfNAxw56WgfFtdevWYGXeZ6b7UNg6H"],
  [0x05, "3", "f013b473225f80924c7b83956e2e289d1a63df36", "3PaRhhgc4vbooLtigJzgJCw4y6vexztc9G"],
  [0x41, "T", "c915c743e9115b1679b4516e0ee5954351d288a8", "TUJSuofDzgVZ26vwdnaJXpcNewLfMqKwr3"],
  [0x30, "L", "38f45ef15b48b1a4b80b8c209ad42c33672bdaa4", "LQR6r99RPrbj4Q4sq2qCGp67vhCoQFHzEH"],
  [0x32, "M", "28a36ae935e0cda959cf702315f7025816834061", "MBc32ZMxHqfdgRwmac1grRcbpca4jYZeqF"],
  [0x1e, "D", "1602fe91af634a5f4608377b5235fa2d757c51d7", "D79UzXvcix5hJZThUkW5CNsrEfox3NeKT1"],
  [0x4c, "X", "20c0c7656249a3035fb9638dc652d6d6cd370d8c", "Xdg2PuPw2hGCoe4zZdbGn97pV75CBozGZr"],
  [0x00, "1", "963141f6d79ba440300f25c467302c1d966bff8f", "1Eh9NFwnsCgNuKwQTAr1BEwpeV3NfkCYEb"],
  [0x05, "3", "62300d7d41bc2130e009fe05b085aa844056c014", "3AeBi6ut8C6NHFLHtwLabsvR89CAbHi6rW"],
  [0x41, "T", "25e150819a505f39962d9c558570bff3ec067b95", "TDRVvHFokfWpXSfXXe689i1sgm9Qjkbfts"],
  [0x30, "L", "6ca73f89a701081432b590b5e6f9aab5829f4d75", "LV8TbYDHa8DEyaBTt1LtCwSR7z9FpUB368"],
  [0x32, "M", "4a273b3ab705a5f9b0ed8b7b18dcfc9a1838a3c1", "MEfFEU8mdF3PmzyLui8AqJT7zd5jBCKc5C"],
  [0x1e, "D", "c7479c164b7eca677a77ecb14ef925c3c26f14b7", "DPJnnxoZ9jhUHfNUJLyfMh9y1treGgAT5Y"],
  [0x4c, "X", "9268db559a8e0e5e06be9a1579c16ce174b1010d", "Xp2z6qWRvCUDm6jiFhudSx51ur1qfPiHk1"],
  [0x00, "1", "ecdda09d063c7010c5dec5f4a02f8da5f72e5461", "1NbRyDNvnkVRgffGH8CVnmaCNr4qusFu1a"],
  [0x05, "3", "09313e8a8482b6f18e1a84bb06f25c3f354ddfe8", "32Xczpm3F1w8DJ7GnVgV1TgmHWUkh7NZjc"],
  [0x41, "T", "2926c76641b427d52dde8e922c6efca68cced172", "TDioAL4pHE1VrE7LLCtBr4WP3eTwVk88pg"],
  [0x30, "L", "60e2c4ac3d267a8a3b5fc62484fab0bb534f3a32", "LU4EnmDcURFvRZ3QS4UL37xCEBnphW8rA7"],
  [0x32, "M", "44e5295024e9bc22f2173836cde6167bab472788", "MEBShtNAbKnSeKw8diPg4keRTHcmMiqDNy"],
  [0x1e, "D", "c0801976342e636382f4ce5c1b0f4b9b72fb4dad", "DNgwjbYWX1dBCi2Foz8b8JcYKshfvADPrB"],
  [0x4c, "X", "5832f8fef1eb0a84edddaf22ba3df4291b39b4b3", "XijCMmwbC9JSNnY24L127dhG9Bj5qSRhk3"],
  [0x00, "1", "84b810875d4421368132f780e53ee8b41ddf1c41", "1D6khMQZoLcKmiyneUTA5MmnHVw5DofjiC"],
  [0x05, "3", "7717efa41f3fce446976050c18fc04db6729afe4", "3CYj1UqjxQjzATRJY8yoQjy87nKbFtJR79"],
  [0x41, "T", "1d3ecd4faa5e79a055ab93a5a0dfd63b8701dbec", "TCdqqBUDZP7K5x9aEJJ7fp9GhMJvpHvTNn"],
  [0x30, "L", "48aaacc594bc13a703186b800e43a24da0837824", "LRrBNiwwtnfeBEP1sSKAiRMQ5v9EmJconi"],
  [0x32, "M", "5f38044a9587e39047d7dbf9e20180489f3101f6", "MGadXmSUHRDgyQMcqysEATfj67LJVegvfq"],
  [0x1e, "D", "0518e126f3eed2b2e62bf33cbbd7e6c3a4477650", "D5c3isjmnVBUhXLMi36ZvNBBX92sF4dGeV"],
  [0x4c, "X", "c5071c34d8c6fbdc4aaf4d35c5af8fe64bd30136", "XtedU4uQ3vPHJecJW4M953AmWm9KDsUpZy"],
  [0x00, "1", "53b808c9242a7a39eec9fcd2596143217c13dace", "18dfYrLPUo8E1jkCrekt8dUAYpKxmwjyfE"],
  [0x05, "3", "2077fe5f988a2805a52b23449d4397521c25d605", "34ehHzCcMGBxYsAt8pYD3kUZj6hZHh7yAs"],
  [0x41, "T", "1e3beb15a0fd627a2ee037ad576fdaa33a90707c", "TCj541YtizLr1uoeH8bgnULkqABwvNkyVE"],
  [0x30, "L", "64f15cda0c513cf2055ba1e2832117111ac0d901", "LURgya3kqrkfkum4raEfyAtxBcAiJAE4LF"],
  [0x32, "M", "4ec99f3ee73e1ee9815d41433a62156bac6f2e21", "MF5kULc6ksnWGircsyRC3feZQCfk99iDPB"],
  [0x1e, "D", "9f8ea4355e298e5a6f2463dc2ae1d4fcd6420822", "DKgkrfFwaBQzebyXktBYm8EhXEaXHeh7ex"],
  [0x4c, "X", "033856ba17fcfc0f3da0e30a45bc4d80ae9e391b", "XaysMKGdfLrWbDFGXS1C3Yfn7giqxd4Ube"],
  [0x00, "1", "8d1a9697c0831624f63c2b87ab7929a82ef74336", "1Ds68S5FXsyzPpYqd5Ka76E7qtfJXPa4M5"],
  [0x05, "3", "0590476ba29441e470df9a12f491deba6a856044", "32CS9BYYRM2N7VKczG6QUtGqQ2Mk5muHAy"],
  [0x41, "T", "1d5dbf1f0bc9da5a10d5a5cab5bf00e98cd66138", "TCeUuFKnkzgHaU1tic6ujfN7rX43yYVZHm"],
  [0x30, "L", "c22c42c07e1e021f4351cc408773de954e35a874", "LcveNieh6KRpSsEFZihASnn898Gm9kzM9h"],
  [0x32, "M", "5b65d307dbf4845a13cefd3d8deeb78a001a7be0", "MGERhmNXrhagYrR6oy8MJQcCVWBBZ4eR9J"],
  [0x1e, "D", "031c71de21194db610f85e8e9af3da77f51cba2b", "D5RYeDJj5o7CMW44MTbeCh574qAbkJY1HC"],
  [0x4c, "X", "bd9a9414b83242fc2100b925962774a62a89e121", "XsyNioofZEQHh5a9GeomNMpjmrvAiwQpu2"],
  [0x00, "1", "8c945fc9a8a8b4db0731bda3f9f6a9f8543dc34d", "1DpKM5KDSC8iVVo3h9B9xPS5cqD39yq8f1"],
  [0x05, "3", "f124b0ca7839e99c32c396807d75efde8fef5edd", "3Pg4j5hCVMzsw2eTjQ5z4TEkEcmuNrsNfv"],
  [0x41, "T", "76256cdc526739802feed79cdd1cfbd615926b25", "TLjua3d75m3gH3Rqj3HUBr886ZshGEyBqN"],
  [0x30, "L", "0d20c5e9c396b2b0aaed9ad4067faa0df7dc48c2", "LLRNJpc6CtPbUGb2tJxfqiKGTd42rZf3EY"],
  [0x32, "M", "66b26679791cdff97e378418be82895f298f521f", "MHGAsU1HaxqXsxJpQ7Nr9yTEuRtV31Lmf5"],
  [0x1e, "D", "80d3b3b0ad1f4bc82bf5b29cf400daf69c26823e", "DGtGe7thL2p3wKGfp4LF61s8rtnsu3PTup"],
  [0x4c, "X", "732d7b230e66199dab18eaa8611ee6424f30bd95", "XmBr2PYWbRtqsgwjf1axrYNX8nP28jcVtc"],
  [0x00, "1", "a6463003bcd43eeace749ee96f80a3a1209aca95", "1GABFZXZ8sQTJZ81Hk2v84PVqSZwv68H61"],
  [0x05, "3", "951d8f7ea030985caa4ba22cfcd16e49dd2cce32", "3FHU22ZtKS3GftkmNmbRR5YC8S6EZL9CDD"],
  [0x41, "T", "828a989eb4fef35b9c5c045b66bdf0380d1255f2", "TMsSspxvKPEETr4n5wTnRZjeFzZonE4E8a"],
  [0x30, "L", "0c236e33e1db065d58677944f60def8b25f02752", "LLL8pGVE3wWEBBPzkXYSbTnjwuCknwR7ZY"],
  [0x32, "M", "9b3ea73454d3d40c6f9781da53546006716b410e", "MN422P2QTZWaFYVwC9Tq5gAdKreUxXV6bn"],
  [0x1e, "D", "95f9db5671566846d21eaef06230506ab4f4e29b", "DJp6YCGgU8bHj3xCifMRQZQrEAQdzdbqW2"],
  [0x4c, "X", "d0dafc2869f2404ccbc6b3ecdd31a032a82f823d", "XujAiVr39KvTw8ebTuLSBq5QQ573PMx1dB"],
  [0x00, "1", "0c4abe93184c149cc4c554968a4f59487675fe4e", "127zedtzX83CMBEKkf4aaVNMyTxgeCVhB4"],
  [0x05, "3", "6a983fd9f2e877c771883d01f9c1afa72da0bb5c", "3BQdwMRNo9Q9aCNXhdQ5CToFmEwJdsxSuP"],
  [0x41, "T", "f68d7bf79772ed4c2d48107a184721f157dbd8c5", "TYSrikHSbeYmSbx1rGZMu7eoV9PEZsjWKT"],
  [0x30, "L", "ca69115024460203e9afa5133d95b214c96bd97a", "LdgCdBx6vgtTEXTK1p2GEP8obGXbDNSDma"],
  [0x32, "M", "32e14565209693714ae25a09cd1764e893881339", "MCYBt8WmAE67pRQz5ZgLkg6t1DsFBY9jKK"],
  [0x1e, "D", "06b879e61e1da507a1e14dc677fc5f9fe62db782", "D5kdb3AwD1TX6F69P8jNkNYLAzXQVcyGhQ"],
  [0x4c, "X", "ea3641268918350b81dfbd38c7bcd1d121ace2bb", "Xx3EwowX8tZasaVfZToQQKKX1FA1TsghBz"],
  [0x00, "1", "1f4f65c223d4e35c211713a6669d7fec4016aa48", "13rZ4aiXiKxiDkHdX9jr6AxWxWieiahVRA"],
  [0x05, "3", "74e0a29a729f8c3311ecd5021f23a2bbcb03dea6", "3CM1Qinagou73V4S2ZJcPuP9uLqRxMuFHZ"],
  [0x41, "T", "9355cee1e8da1851422214bfb1b14c4cf537cb98", "TPQF8K36jCyjJN7z9kaSdNox1GZ7WQpPBV"],
  [0x30, "L", "2a190d3b01ae873ebe7382804b23e091a8ce8496", "LP4YeteQDJuMfeGZZjjDu1hvXk3wTuVWU4"],
  [0x32, "M", "02f267b705da214b4ef093c9c50cc9e6d0225e23", "M8AjyRCQb2vbVJQ82XZtyqQaoi4X7DD8Fu"],
  [0x1e, "D", "bb45129f1258ed3888e1c7c72b843bffc03626f8", "DNDHePWFTV6zcwCU6i3x81SrSKVZPKuq8d"],
  [0x4c, "X", "f18013364ad7c31a2af2b6b5c2405d6f165ee38e", "Xxhn7J4Dm6UzDAPuP8gbMP7huhKtk21zcY"],
  [0x00, "1", "ea24632087cbb3d9874050dff9093220289b7372", "1NM2i7kPsitSzXL51u7iQHNu82v8vSnu5U"],
  [0x05, "3", "a2aa591d64bdee173176bd43f5f6f4ec4c334e53", "3GX7Tca5pSkmufaeYqyU1rvz3EdSMEgSW3"],
  [0x41, "T", "72577b4ab594b39e6adeb609187df7e211dc4090", "TLPnqFpngzGDny4ydXGnkFfRUy1rXH7FZz"],
  [0x30, "L", "285e1592616fd0f567c896640a0d8954d43e91c2", "LNuPzyY1wd9L5NbCf2Ki7vwyKisZi8wjk2"],
  [0x32, "M", "9ac81a8aa072c906e51e7f6b3243fc29bb9052c2", "MN1a1RGwYvwaE2wDzyyzuKNj9FZnK2pAr4"],
  [0x1e, "D", "7ef5c773283df797661cf28da95e58df805cd1e7", "DGiQ7Tez6q2Ky2xoHPYGR6sDmU9RnodboX"],
  [0x4c, "X", "c1670ebc83a7d9e85d325654c94655c95a0f74b6", "XtKThqn7GSb1rNqPy7wNSm5aKeCMjKmiyE"],
  [0x00, "1", "0c53bdf495f1023db6d80370fcb68a187e8899a4", "128BRoM2VuPyofQ3B4yH8Yhg1wRSC5mZ6Y"],
  [0x05, "3", "ccc0af8a410cf455b8295a56f3c321ec7cd1eb8f", "3LMebiPx7qPffqdLadt3ua7Lm61qhcFkkT"],
  [0x41, "T", "b9597178af7a4855bcc2c791ed63128822e8b6ab", "TSsFAB1gCoA4UdsWW4cokofgLAs1hBJsxT"],
  [0x30, "L", "028ce660187e1f7cf9a41accf441a5b54e4d35f5", "LKTSQVanb71fuZwYLPBvHY3Vj5jRv5DUpn"],
  [0x32, "M", "bb6eba910966aa838f644b807186b5454fc33fab", "MQzDEsZxHLqmZrrTzjEXnD643F2XecWiBw"],
  [0x1e, "D", "18c781ee8b44eb5b6661ce20c17ad50e203c5d9a", "D7Q7ktZBUsBg7jvDYkvkSfbxiwkAFPjJ34"],
  [0x4c, "X", "af277e8dbaa0efa5cfff668d1b4aebda4598dc7a", "XreyPwSBmfArkVpGH1BPHmFzvPVyEe64Lc"],
  [0x00, "1", "5ad8f24b3214c5a88eaa5bf65a8153c2490ef1cd", "19HMhyCpaWyUEpvpvwvY4bEsdAqLyYLXBE"],
  [0x05, "3", "72d8eac35043fa4beb99f6e47b83d8d65ef22f44", "3CAGp5B55SsNXg8tRxV6X5TPJokTpTQNVG"],
  [0x41, "T", "da04550a54d9f8a6070e99b8a24e19109676bff0", "TVqyVtDL9WmTccAP7V9mLJkFz4MTxzsGfc"],
  [0x30, "L", "44fed035b01ae8e640425657999c9e2678f43e36", "LRWmTzo82fg9EMytQyPwKcA12AoDhadEri"],
  [0x32, "M", "34e3eb4317c277735bdbe19dee764e14056ac453", "MCipQVe4xPx7KykL1tF68aG8o3RwmfSeYP"],
  [0x1e, "D", "046356e80f4bfd5ac0c72209e0c0a96527b2fc38", "D5YJFFfo4AyXQkP6fBSSVsdEQjzjoY5mdp"],
  [0x4c, "X", "f25bf05c7b6d28e7d43a1aeff304ff5957bc7093", "XxnKVhnNiUr6FNzovum53y2uqcdUANYAmH"],
  [0x00, "1", "10df3acfea4cb4b384ed8655ee6339dcc18e441a", "12YDELuVYZ9719DmER5ZW5iMSAevX64FFz"],
  [0x05, "3", "bff644e29f58dc3243ff6fa295287e63ee033d11", "3KC21FzHxWX7QjHc5MNaPKLx8y3s1TdvTS"],
  [0x41, "T", "11262f15d0da2a66e6852d80542afc271e1e6aa5", "TBXtEPLFhRj463kqBJr3z9zG4LbZXZBizk"],
  [0x30, "L", "cb9a36b9e270f69c790fffc888eced542d78caca", "LdnWB7ebxRKYD8aUccB73PxckW24PWEEgz"],
  [0x32, "M", "3871a3bb8892cd09ac38ea165ead4a427594a714", "MD3cCzKmCaEnGttkAFa4gTns6ueeJFbCgy"],
  [0x1e, "D", "354e6231bc504f3dfd80bea52b774bf29eae580b", "D9zxFcREzAV8BRmWoGytbhy6EQmiUzZHUD"],
  [0x4c, "X", "f897906d185b5fbb7ba7651df5703bc6155a2315", "XyMGygz2sTCbH6oHrHt531hAv5wAzFt59i"],
  [0x00, "1", "506f9af548b00c5a77582d152434f662d0449b78", "18LJkpW55F26ryR9QDrM59Wz19DtZmSLaN"],
  [0x05, "3", "3147367a57539688d450b74de479fd3fcd0044ca", "36BaLtupeJkLfBjD5yaytMR37VCrq7VTSt"],
  [0x41, "T", "9e4c6329f2f804aae69035c7431971cc644f65db", "TQQDGrYHc2GKqxaAJ9B2Mi95EGxKXbP6D1"],
  [0x30, "L", "54e3e52cb42fe261fd5e4796c6db781cb3da929e", "LSxp2mFeHGw1SQ2M33rgYdVzH9mbRV7pUY"],
  [0x32, "M", "819d55000e04a90bbcfee5f8011def3db5dae28b", "MKiVsoDCPBNjWZjrJw1451Kmp75mCxVvKN"],
  [0x1e, "D", "10c066c64ae0e1e064f7f5f3a6bbfb1c9f5d422b", "D6ffqcfe9G2mjSfhUHcEkVtJ8BMH42tcA3"],
  [0x4c, "X", "9fcf97af304f8c4a7cadfc777dd794b027f096fe", "XqFqxY1UFuHPh88EwTaFVSGnqp9yuXuaiX"],
  [0x00, "1", "9ecb1bbb88441ce333ccd4f5532f3ed62bf9ce70", "1FUd5XMi1rG6x6RwRH9XFQ6oA6TiD4YAhN"],
  [0x05, "3", "ca2eebb27e064a18c77f72ddb9e5f84460362d62", "3L84dQB3hnSrwjHyPEsCZLBL5n1kjgTZro"],
  [0x41, "T", "fdfb7531835397c281c2f135e36c2cb794baf849", "TZ89CBhzmcQEqrkKrfbRP3WqXSp5P5ePgC"],
  [0x30, "L", "cb7ccde841993482c8332faa081363e0f6b367a0", "LdmtwiCUq446ei8VAP8KcJ3XD81NubqnvC"],
  [0x32, "M", "07942c7f96827280e8c42a5ff3ad61a36e8c3e73", "M8bEU53rbM6AE3UiLNwVJA6wRjEa5nWusf"],
  [0x1e, "D", "74be09d3d7d1ad12928eb990735185a0ed873e88", "DFnNacJcN4QuJdNSw5hdXRaF5nVqpEyYvJ"],
  [0x4c, "X", "655b4e5c439a5ed542590cd1874ee0a8e3eefb94", "XjvmTgoWc689NjuVxcogLaQgdkwAH2k8eZ"],
  [0x00, "1", "73881976ac75b4100d26af0f59057c078a8b3462", "1BXskRCdhWfJMbm7GmmtvNuoi8MMfYw1Xe"],
  [0x05, "3", "0931030fa7ed7106abb360b7aa26f727e1d28a3d", "32XcigSHF5cRUyTBjWUhZsESTPaQUQdsXg"],
  [0x41, "T", "b43b6778a26272e0b7f4b471c3dfd5b912576373", "TSQBo4e7PWjwpb2sKHM5eKsDXTqFZxWzaX"],
  [0x30, "L", "28ff25bce1f65be6dcc080859c30783bf37b5ccd", "LNxiwqdfiK7fReciBRDx9Hvb47zycyjZEw"],
  [0x32, "M", "70b126408be10cef6f88e7a41b76d2f09ff95d9c", "MJB28UNukpKL3r8B4MiWWje2PkHfCa9DGt"],
  [0x1e, "D", "cd4aeae36854f6f772ad9afaf78e66e42fe4a1c7", "DPraowmXWe7k6M7VP43GPUY8azQe2W1nrx"],
  [0x4c, "X", "ff560b87e71929f84db126dc2046a19d37a7a13a", "XyxwDgfBBHnqqdPLCZ2VLMN6H2JMMzdJk7"],
  [0x00, "1", "8c7807f555ca977d7845a88037afafd47b20f02c", "1DojPmDkRZeqPZormZt4KvxBYJ18X3KE9r"],
  [0x05, "3", "ae12443c422327cff88cc1c5bb80d8bdf00689c7", "3HZRP6z8dnDDuY6LymUAYPceHU4WYQDV31"],
  [0x41, "T", "cac42dcc9531017cc4a795f31bff0966d018b3e9", "TUTLWZJyNLZNaRjVHwP2B6W6RKR2y2o7Ep"],
  [0x30, "L", "262605409eb3dcae17255568b0dd321bf2b78269", "LNhfVDPZrtVTXZqtjbAACnFhuQ2ZTPrtDu"],
  [0x32, "M", "0014a62b6dfcff4899f5c68c8a584fa73a2fdb4a", "M7uay9w58VNFT7YrUKp5nWWTFeHfLuT6rx"],
  [0x1e, "D", "3aa803753152da7f7e2c379bbd46f197e0994ddf", "DAVF1AgUTHds9gLSnAM6aDhPYukPMSekeT"],
  [0x4c, "X", "4ec6c3b8a2217cbf37a1fa17b8faf9fa61bc09e2", "XhsNecpFLPjyFksoXJeqnm9mswusDgM1ad"],
  [0x00, "1", "b3a9ab7eaa3dfdc795694c5f94657a67f28f0385", "1HNyDD8KwFfWZCMu43gwsRhRrjkjrQFtQs"],
  [0x05, "3", "5194208455abb5044f6bbdf693dbc34e5a6a0e0a", "398N78MzrBmJ3wM2wn9qMPK7gk4zzN1SK2"],
  [0x41, "T", "9f6f5d4b5413a1666e62e380f9957fb19b458560", "TQWDrJ97LtrfVHoRgDMD4s7tiNeEtetarC"],
  [0x30, "L", "084cbd67aef0db00c2408656a9940d93743cdbb3", "LKyqbj7LE7usiFTAqgwXD79vbtQx3zFATN"],
  [0x32, "M", "b3019de8cbaf86e605c41080aedfb72c1f0a156c", "MQDf87BWbJ21esUH5MnPJbavP4HfWTdQxr"],
  [0x1e, "D", "e0eba081c0010888507fd16e9a16f3f80889d028", "DReNAssw7Rh4nSoeSQQa9g5QMZUR7hnRjZ"],
  [0x4c, "X", "0dbbaabc4491782fb0b61821f393ce3623a14167", "XbwTS5Guo4kMkgrdAAicrSmFfvJ5EGGzHy"],
  [0x00, "1", "a262e761a52b065b234413d826486595dd800e48", "1Focx33yVGvQvmQtjttPR5qXjPYoHzshG1"],
  [0x05, "3", "5b904621158a9b5eed2b4703a6c0ca60331bb16c", "3A3AFL4wJEcqajtqzXv6GSy6VFa6QRVjS7"],
  [0x41, "T", "306a3a6b3954a50526604d7e56b5e1454c012c7e", "TEPCh8abj7ouxp5m9QsoDbinjH32yH9nHG"],
  [0x30, "L", "e2283068b35c41e69a4ced923388647ef9a0e2bc", "Lfqm7xHzVFz7uwKYvfVevM6nFnCpHttWiX"],
  [0x32, "M", "cc04d2dbbbffa24d75fafc0b802d126c700942d9", "MSVuriajKkESSnTm8LjzvuKTphNCzRRwzG"],
  [0x1e, "D", "cdd877eb12b3d67800a790df4c5afe8a5137c270", "DPuWP5EugnCASYxL2gM2MmKacf32PBS58c"],
  [0x4c, "X", "fe08dd2ace2932ff73e37e8435db5aa776b5a408", "Xyr45rZeC6q9aeJMMGv3EqBDhqp26equ7U"],
  [0x00, "1", "c1ea845a78867ecce891da20bd37597bda356e9c", "1JgLMYvo1hT7izpmHSXjgaPjoNTu1sYEWG"],
  [0x05, "3", "926110fde649b09654dfe67cbdbd29b86c1e14bc", "3F2zrqj5FnZG3kBiyYqA13v4JrXMc5d8Yq"],
  [0x41, "T", "2d71b22419d931329f43f6d22981c82afc92bd0c", "TE7VcRDuU5GybckRcW9kbVxKBbrRVptkL9"],
  [0x30, "L", "a6821dabd304df447020d98560a46c8b2bc2cb06", "LaQNJfiRHXBBRXYC6RWeKrgXi5TtReNSTi"],
  [0x32, "M", "319e0d6e2f0acdbefa8f217b5ddfb40466caecd2", "MCRWgWPUGT4ei9MAgvP3W9StFywPsKz4bS"],
  [0x1e, "D", "fe3861fde3d879e1712615f992127b57ce522184", "DUKHiXZAoSryMmqc2Jnf4t9nQRqqGTUkGM"],
  [0x4c, "X", "ed2c181851c951f3a39618971050230aecf2be8e", "XxJtoRvW8DxDJccpzjS9uY3JEVekXqPQrz"],
  [0x00, "1", "32257204bcc627fa0a8281949e20d6013e683aff", "15a9eLs4ZnoTZ6kDWhUW8TNF5qzsmMx2Wa"],
  [0x05, "3", "324a6eb2ac707ddd2657b5afce30c60288b58922", "36GvsnmzdVnm3pprTEinn9h2KNkgwoQnnx"],
  [0x41, "T", "8b6546c7328a8b3e003a7e95ae01b332e219ce23", "TNgGFY4kVMh4J7GkwtV5TJPrBtxjuSCzYa"],
  [0x30, "L", "250a3ddc12e9f4c34381fd07bca6c5a61545dc8b", "LNboXusGv3hrM3cbc4J5zyfoZAXHnWYiye"],
  [0x32, "M", "78eb591fbcac9a5c14d59fb765c21bb4ad44b814", "MJvXFj2DZHnqCpSEsxbM4YQb246bTVGMaW"],
  [0x1e, "D", "551a454d349de79425f61770f9975808ea17a427", "DCu5StH5scSzKHZdjMxmgNZKxESqaTecss"],
  [0x4c, "X", "6c977b5b257684561bf9b23fca95cf111706a323", "Xkb2H7e1EHvRXKdHTKMuh3FFhaRyBJ3gFk"],
  [0x00, "1", "3a1b6c93abfbf8075d3f4380a2254097540a80cc", "16JF3b73U554uWY4icZXW2E7rcPfDtuWof"],
  [0x05, "3", "22ce58446d2de3b45802f963449134bb891e6c98", "34s469s4RrF5FiTZHpVdnhGAtQ3URpK9st"],
  [0x41, "T", "99c5f89fd803e6dcd561d098d52ceed8762ec973", "TPzHYgt5L6WBzZCSDg6PbnBkf3houd1Ma2"],
  [0x30, "L", "b2c33f6d08b08b8c7da14de613b224234aaa09db", "LbXASQnLfvRuurwSntj6CVNoHJD3C9PR6s"],
  [0x32, "M", "c19fa33ba2f46234be476a64a9bf2f52a7ff5588", "MRYwtGdjLFTsfe3H6FS5eE5VCH6v9LoV8E"],
  [0x1e, "D", "ae4e1e938648e8ef62d662f37a6ea45e2f570878", "DM2jhUFcmyUJJKa7MkvNyx8qR8L64mkj8Q"],
  [0x4c, "X", "de76b12ae3297dd0d2040eb103bd7505f09127ff", "Xvy82i4YSmbde7RGvTGsMRCsBUP3Np67sN"],
  [0x00, "1", "5f317960d8c51405c16af1d06abdadd876b6802b", "19gLTkKrjo9DnSmZCbhvL1i3masVJ1wUkh"],
  [0x05, "3", "8985bac796d315f25d4c8612df541759241054dc", "3EEAhX9UpKkZxmBGsK3Fx124c2P5o4f45x"],
  [0x41, "T", "4a50793920739103d2d79d34527df5c59d746e60", "TGk9Qeqbt6R74RzERdVhzSTMF3LcSQCj1T"],
  [0x30, "L", "7324d5cb1962402bba0169e130a5c80a06f086a6", "LVin6d6osUxTBJK5DgEXxuqnaSB6vhrgAs"],
  [0x32, "M", "4bb7dc591f297bee84c3b2ff144377dca96b4d52", "MEoXAghZb4wYvhcSVQyXd6UHLsWYt8zBaZ"],
  [0x1e, "D", "9964458a4c8295b185a16a5f7af8bd7492f4a282", "DK8A3c15BFWoBEcUseSwYFa32qf5e3KDP5"],
  [0x4c, "X", "48330ab325d0c9ec3be264c3383a1bc23a0f8f19", "XhGbdWcf5rhSmq9oTaG28mqh2HBZVxS5pV"],
  [0x00, "1", "5686dd78461ce8bad53797307a0760624b86d84d", "18tWg6DiXRDo1XdBWFxorxh7AZWEXPZSEK"],
  [0x05, "3", "138228a860d2e1e63b5537800a6bf72566d918a8", "33UAgnJMdAxnSv8WhaWNURJHQTEtgDWUcA"],
  [0x41, "T", "48805d135cb66a42b6f554cd8676092eb6f74a73", "TGaZRjCnENatnbndJ4t2jNyujxVSkrGvdC"],
  [0x30, "L", "0813b4cfa9f7d8ea9dd161fbd0b1f8ee6845582d", "LKxfGxvLMhDm4Nziddi3Lg7GUFKhpxuYzm"],
  [0x32, "M", "678ec7be4756488266df8b136b26d1e3e491f966", "MHLisjY9YDTLiGthvr7omLPivpRPUA62Qh"],
  [0x1e, "D", "5b7d555fb1cf35c7facf1e9d7f163269a929f1ef", "DDUrB3CJcTwzt77kxUDoPsTEsT3ks7WQdQ"],
  [0x4c, "X", "12cc0600ec42ea20f8d998973df3b70dc30e2097", "XcQEQWCs2yVjkberz9FnLcKbe2yPWoRE7a"],
  [0x00, "1", "36d53b09227062a4292231382c209880e67ab030", "15zvvt7TPt11b3GSonBvVtwyDrVx2LC23e"],
  [0x05, "3", "eadba69a372427a30abb8b538010be506f15de49", "3P6qB35EsUeLck7USfwWGbJD35bixV8d5j"],
  [0x41, "T", "ac2a1fd2cabe14459a614d85477f917445a84e05", "TRfXguHJSFmknADuQK94owCNVWUH8XTrG9"],
  [0x30, "L", "4add15196378588e0edfa18eb72484e4ffe3bd28", "LS3o7V38mqHtgAeXK5bFeqn1Tv7ryAdeP4"],
  [0x32, "M", "224affdb024688b1e1d4ef328cf773734bf360c2", "MB2V41DbYWCvekUNHkXCY7q6H1cWmpAFc5"],
  [0x1e, "D", "9dd30a895f7e1775d40cc037264a8892fcd3b179", "DKXbSmmECfXba4AE5QCRFBRfjuaFuVnKEh"],
  [0x4c, "X", "a9415f49bb31938574449a17ea4e40ae4384bc30", "Xr7nLpBCY8Y2i13ezQ2Hf4SyjkWfQVqxUb"],
  [0x00, "1", "de19b7503e5b8b8d28856ace1c6996bc823bed5b", "1MFMpNTznbdhcAbQSDZntJomXaK4fxxJHE"],
  [0x05, "3", "3fea3a0ef9f8ca6d15dd29f7ad365d670d88f739", "37Wy5zUjVWdACTXprMP7X8ySPaFpYYa113"],
  [0x41, "T", "7157f11795b9bc379f5dbc9eec6c03e8ccd94ea6", "TLJWi36H4WDUenashtMFJWST3AxhTc8sbK"],
  [0x30, "L", "bbdd2d421f02c7ef5016e373e89cf6be1d8938c8", "LcMHaibvnqFmQpKdM6Z5bmjmcfFEVEfpYr"],
  [0x32, "M", "fade436608eac94fdaef696f6381ea039fadb621", "MWmdRWazu2W6qRgQBAzcFMY8AhjVoNge6W"],
  [0x1e, "D", "00ae65d6d4e03a28bbd130b9affbbd63c8f43e05", "D5ChTdXoXyL3Av6gmpGyk3KHHyu7gCFhqc"],
  [0x4c, "X", "c868c19b06f3d8e9bf63038e1c2998e28743dda8", "XtxWUDJV2ieuJRrm6vwkJnjsbQM531YM38"],
  [0x00, "1", "3cce2f1d5d24dda057c6e1e86804effe17f46912", "16YWYRqTz2fPtZqTZtGjcs581wN7fkrgMe"],
  [0x05, "3", "8dffabd2c8cf22b482a7fd0b964c52eb2ef9c043", "3EdqUwK2oebXvYmyVbyaRkYC4Pdzu3kpRq"],
  [0x41, "T", "6f62543ceff36fbeadd6abc3c32e17a4bc7c99c6", "TL89oNgg1vsKmzWsBwxyBCehfbg13v2DNe"],
  [0x30, "L", "bb25a24c7d9c598f86174de77816d371ddbc8189", "LcHVhwUabxXaeEJvn4f9in4DbLN2P4FtUo"],
  [0x32, "M", "c3339900f53b58c0d9b2076702f46bca6c123d84", "MRhHouWWsDkqmN9XkAxf9HvrwAyzXSaEEA"],
  [0x1e, "D", "71e1e8b39946a420734e76b04431e92a495ade1d", "DFXFXNFDQYPBBXUFFvqqJQrM7588dRqJB9"],
  [0x4c, "X", "ccae87eea63c2e64d14633d6f80e573a7044cb97", "XuM6m1fgeAhxuAMydqRSYUXudTePdV33p5"],
  [0x00, "1", "aaf63bf74806906f5a7346c7bcb99d640843ee86", "1GaxrGSdCjia3oWJaoHoLGTBayeTrQsswr"],
  [0x05, "3", "45b0406eaffc55492efb2c4a90b4cf7664244f18", "383VgxkjF5gRS64d6a19RnXUB42mBBJo4H"],
  [0x41, "T", "03b20ab457bed4a5804cecb96a237e5ad0807741", "TAJkKCMgVyw9t4Wx8syLs9tqYzeZcxiCFA"],
  [0x30, "L", "e61550d6bb93f7c58b070e378597ec4d4f4b95a7", "LgCXDP11WgDSkQBfPLxPEDubi26RQAi53D"],
  [0x32, "M", "13dd4edecbbbf69fbeae8c459fa66a23b6fa520b", "M9iCBq7pWNCHR7G6ZjMVbT5KLvVSem5AzJ"],
  [0x1e, "D", "3cd032cc357cb7ed74c41ee6957fd760953ebf2e", "DAgeVeaQoNQkTVPdGMpauFHcFUhVhpuzAN"],
  [0x4c, "X", "83b64bd0d7cccd2d66f50155d94b737609caa70a", "XnhGjYQ9FCipoRUG7VbzJpGryEq39688XE"],
  [0x00, "1", "71b1a493744542e0802c80c627223c443d16546b", "1BNAAXAsQ6yNqNxpFtoZHAcJsvnYDkxeUd"],
  [0x05, "3", "062836c47121c47dbda0d91f90c57e1332a9b1d3", "32Fa9op6uTjQnHAXp6w5dRy9n1PeJeACu1"],
  [0x41, "T", "b608c61d5372cd0b0acd552b47767d419fe0fb05", "TSZiVbJvYByvzCMK41ruRYJGHYQG7Yy7jp"],
  [0x30, "L", "d0d4bed01e42aa85e0ec786467fc99f8e1697afb", "LeG9fvMXsjySAW1Edx6FRViEHfPLTNyL5q"],
  [0x32, "M", "1ebc472def0471b941b86b3c9367f2246e146257", "MAhg3yPN27ECEnYSGsczqVUQ8WXCiZFbxs"],
  [0x1e, "D", "e7b0a1f6e0df89f6f532f7613450ec2ed552f21a", "DSGAEDygV7zuuoDAFbgwh9PtwMdY1TJKNE"],
  [0x4c, "X", "4fd364213e3c6facf0a7f6a226ca6688e27957c4", "XhxvT7zjJWLM6dM7hd4V5ySocH38DVFuea"],
  [0x00, "1", "ab02341eaa7a69d98951eda7efd9d3e3917e8b61", "1GbDBurgvmRdkkQtkwAJpPzoXSE6W8RhS8"],
  [0x05, "3", "1f95a5fc873e71882b96bbeb7737d57f3a707345", "34a29F29qKft7RGZziY5WDgWcRqmsA9cEF"],
  [0x41, "T", "51e10e3bc12d2c2504d28444b8cf27f032ab8185", "THS9LjYuX7JPdc4qDv8cjkmk3bsRs218C2"],
  [0x30, "L", "9431382acf0e2d74648c96ed65869ae3a08351ad", "LYjXERn4MJvouGhtxYZycg2qqrBvQySPDT"],
  [0x32, "M", "b163b4e6633305eeb630c945b080edd3e33e1186", "MQ57H862eJdBKagat9SVhFkTVvXsAUyzWG"],
  [0x1e, "D", "9b567a0a4e66064535f90ab14bc8d70b3173c8cb", "DKJSsVxBhbmx96EKr4yRkkXxacFknEguQy"],
  [0x4c, "X", "ba6dd7a6126fd11f7fd4007ec609d16019b4b024", "Xsgb6v671NZtGyqWoJgD6vt9ddRix2FAfZ"],
  [0x00, "1", "883cb8593805d564fbd073bf88356ad106c7141a", "1DRMdznLuVmPvcuywyk7AZ41Haso9DkWWN"],
  [0x05, "3", "1bed547c71b85e2a2eefea3dee5c6a997cf9fbe6", "34EgUhgsA1VGdMYwRmTuTC6mbUgVsdFnQm"],
  [0x41, "T", "e3b5e59e59bb597ac5dfb5a024223f664ad005d1", "TWjEJ2Tf9otgD8Y7P9Dk79uwNWWDafnBA2"],
  [0x30, "L", "2b35c3899154954f502f31f02e2ae40bf87995ce", "LPARj37eaKkm9RGH3AsFuJPJaMANF7fMNH"],
  [0x32, "M", "0363280e15d8f4e0297385045efd3b7c0a305eac", "M8D53Wyc87DC2ZCFuJCuwYKiFiQTusBHiQ"],
  [0x1e, "D", "2519a2e688d2081daf90ef6596dfa0a82387ee7e", "D8XGFbjMLtFK55D2d6TcYhus9GG5cue12T"],
  [0x4c, "X", "dba9f41fb23f11b95ef8dc7d403c595c88579769", "XviKQr9AKjGKZP2oNMVp7ZGj9MhGzwuHj3"],
  [0x00, "1", "07dae7af2a7b2be1b7d1dd5f3d9a1f96a05c7bb6", "1iXy8YMTQD4HoJZMVGezf7CrnruxRxksa"],
  [0x05, "3", "ecde7efcd6cf00de914cd57b05aad2e3fdf5ae7f", "3PHTw7T1Fa2hdvFH9s46RBzSaBNmEhsPi1"],
  [0x41, "T", "47e2545347cd748f4dd2d49c95b868c03802134b", "TGXJ7KaKQXBV1fChjdhsCc5cPnYimHfSyX"],
  [0x30, "L", "2ab91bb97f3ebafe575f11ec82f0065bc872ff39", "LP7rPpWj7dwCuEK4irYF2iX91o9mZFGuKi"],
  [0x32, "M", "cae07cc0fda7c0cd3fbbfb9a752172b7bfa578cc", "MSPseqEJioGQ5zSmqCbRHdRpFH7Xr2keBm"],
  [0x1e, "D", "b0c13c94be48738dc9d5c160df7ec4654afd5cba", "DMFgxLZRkuCFhNPKoctLbBggDaEPGFH7Ab"],
  [0x4c, "X", "e7ac154539762fde7fd710d9dd418a72711a7563", "Xwop57GL8oo95mymbFyXsaetuKbtpae5BW"],
  [0x00, "1", "d6cd74c2601528f7446cb17c8d8babde933f5ca4", "1LamjPguD9PCKwRmYVLb2jLJvPLzCBfwSL"],
  [0x05, "3", "83df61631b94abe0b42e5a0740d0ae324891f764", "3DiJ3R9RcarQtNFHyUC3eSJ5abvKLx8bdU"],
  [0x41, "T", "cb1863556ea3f1006fe20cb921051ca402aaa04a", "TUV5PWY99Y6zcQsa8XpUU8jCGdLzwBg3Nb"],
  [0x30, "L", "f587dff424475879483dabd8ee2eba85d3b05552", "LhcCaxbgQ2eYjmfuFZEx5FZrNb61j12ndC"],
  [0x32, "M", "90b86543b1a911e8eca4d8ed66af57131f2b7e4a", "MM6NS5ihUM5qK6hofaqmqg7Z241jfhJBnZ"],
  [0x1e, "D", "0b9efe420bd6f20f427e0cafa446e48af18f4d18", "D6CYSQheJUt1ZfgC6uya5zPZ5tutd7tooT"],
  [0x4c, "X", "eba3533bee846ec470e2668267919dc70adc40a5", "XxAnHMzkUtXCKnHuH2f8mnStugguZWdyVL"],
  [0x00, "1", "999675cd0b81cdb7debe1f842a901ab362d937a3", "1F16dWJe8QMXuGYNLHJSy76z85C4mvnvyn"],
  [0x05, "3", "ce8fae0ac2af86f1cdb67f598dc85f550ff364ee", "3LXDF7Sndi3ReXRzk1uAv64Q7vpvGaQzRd"],
  [0x41, "T", "088d8306e39f8cf8b73382bc00ae14493a6560e9", "TAkRw1PccsLdYjz1f11xuNMr938hfBKwjn"],
  [0x30, "L", "4ba7d51d471305421594b50c4eee4c808023983b", "LS7yzofHNgP252Y1NuMW3spVyJzhB4i4US"],
  [0x32, "M", "253901cee2e4cf95b21ee6072f3023715003e511", "MBHyXSwecSi97PkXUgi7LiW8jfruY5WQhY"],
  [0x1e, "D", "d3a0bb46c5b9c2b55fbcdd5347177fb6dedfd359", "DQS5fZLrfEA2stPa7FcmMWocdgji2feCLj"],
  [0x4c, "X", "50ff9ca3c4374e00321d7fd403bbf87e75637b36", "Xi586pm2boUtB1YSeGsGWvt1DdTDbyALmZ"],
  [0x00, "1", "24d3db3c47ec5b60b6e81a8ca98c11a5e7fa0dc2", "14Mj7wrnDC82eFe5kQ6bdzUi161t7XFXfv"],
  [0x05, "3", "5012f8e1ee159bca460f13457ef20540f074c6bf", "38zQi6qwvkcWEMmp1oPyxxAettS8P66cxp"],
  [0x41, "T", "8961721cede6975d4e1dae87cc8a4db6086ed7f0", "TNVcJzLkfpKaGhSsiDDFjzFdJS6k2rPXYY"],
  [0x30, "L", "9a437fd0c7e44312f7c4005952bbe9b7aceadb7e", "LZHdBgoWiTprWSCBQG66NZKwg4D2ioPLb7"],
  [0x32, "M", "4c6a0652f2c7eff336034fe8cc147d80ad9af5e3", "MEsCbjaCqc3sc5JqWVZ4q2SrvmGTWq17wW"],
  [0x1e, "D", "e14a9c2f43ece2c85dbb9a4620194110c0c47994", "DRgKxRMKakmmb5tKiYLdsfcz24Ez12TAaF"],
  [0x4c, "X", "2fd9f5f497a9b8152d98b4ec3e75d7eacd5e88cd", "Xf3rhSz7gsmnbyAjxMDxSMGmc13GcWdtdH"],
  [0x00, "1", "6cb5c3c838b558c1524a3a2bf1574caed93c31b0", "1AuoixRaDWK5DytiSS21ZvvfwN1U6tN8Pd"],
  [0x05, "3", "fb4bf8ca9bda6a72b9a2268d044972073ed4def5", "3QbkYJtgB8w5Keudq5nUKD4yxtjyhZ7YzS"],
  [0x41, "T", "8e2ffe89db6be9102aca1b2615825e63320c554d", "TNw2SzzgNYwZcSyWvhv58Af4ApjeR6VxdM"],
  [0x30, "L", "d774168b95772a4f40ae0f0e3e71e2094ca60dc2", "LesAcPyMngxVRvj3QbYj8EMgL3dykMU6N7"],
  [0x32, "M", "7133b96c02f784622953732403fa9774549c9447", "MJDiYyV8yX7cf4iJDDMBtVFe1bEHaaD5yn"],
  [0x1e, "D", "1f07b790a2a156e76d2f569a7c74636e354a00bf", "D7yAjPsvkxNnqntsRj1z4J2G7fQZRZ8EBu"],
  [0x4c, "X", "8b59bd1d76f2015124ffa4f89ed02fdb895cb887", "XoPfG5FvWWnKmXjxUj2c737FFsLy41CdfS"],
  [0x00, "1", "dc709bf50536b956f269c2e9caa2fc39fa509a82", "1M6aZRoRsrg5aKigqo4Xb1zFj75D1QsrhL"],
  [0x05, "3", "dabcd6eb06caa9135855259b2cf843197afa32d6", "3MdbTAQJcTB2VaxbPJnP8VfHZH7hTP6D5v"],
  [0x41, "T", "b2a606ef6fcf4ef28be0d151218ff2c6a33f96da", "TSFpAyB6EFmykfVYJ73Tcv7vWH8SeKh8Rr"],
  [0x30, "L", "ce563be8d73f7ac25a0205d3b9a447860ecb2620", "Le2xmNhZPp9GkWEy3Q7g1P8Udt3ZX1p7ui"],
  [0x32, "M", "2f27fc41b646d4e1691d905b1b0ae0dc5de5f235", "MCCVtgLHtEqRiRDC8HoZhjgmjX1VrE6zvD"],
  [0x1e, "D", "a33f7b584fc070e38fe76cd75edd77661cad800f", "DL2GjKZ9pq9jYJKyzduS22Frh4Nbb3zb4X"],
  [0x4c, "X", "e9b08baf093c353f50f4602c6f15b844eeca0738", "XwzUmZCks8ANoyNFpjsioXpiz5gFGvV4vB"],
  [0x00, "1", "f2ec891df46390a7fcfe2429a0db5db63ffc1e1a", "1P9TtCvHnFNrMx5LcK3gcthtPh1ixQ7Dp8"],
  [0x05, "3", "5d866787c16ad671b46079830661ba383e4fc9cc", "3ADXmy1TE52JakxLYAvmRYpT8qTCpKykto"],
  [0x41, "T", "14943af035710650287462f40b182023fa084443", "TBr267ULm4Lfuzgf3ZQaScYaJNtXUGN2AF"],
  [0x30, "L", "e9348283998828891d1a52a37cda6983bc43bb78", "LgV2cMb9RzW2FhMUmWYFbT51rJdvRyNFfS"],
  [0x32, "M", "ef6b4d7cecc61a5869dc57d37a9a30e810b36697", "MVj6GoJP3GJkDzWA4fLpxY6sf6cBEnGnuR"],
  [0x1e, "D", "a895a13307b5cfaf315a0f1654bbd66f3b27c200", "DLWVJwQ75nUzsUhDMghChpQeJbUhCam9QW"],
  [0x4c, "X", "ed2dd10e9e89f4abe6e8f3ba4dc27b4df691b031", "XxJvs7UekHKXsJai4rtDL4gmb4XDByFWzs"],
  [0x00, "1", "f364e86d7be9fd43e1de9ec0f123234bab0bc86f", "1PBx5pZabkcwyouyL6U3NgUQRm848Uqaw6"],
  [0x05, "3", "1019136e9c42d1f7f7415adc5e380f7a2dda7bdb", "33A8mvAxkoPWQjM7k4pfZus4FXpeG9eBY4"],
  [0x41, "T", "fd1abf2cc757ed0a0951ff5a030f3e6e49ceffa5", "TZ3VzzR7TQVrr5rPBv5XRNsw2kyJzvK7mG"],
  [0x30, "L", "327f39f7cf0ea87d78424f99e34de98e2398062e", "LPpxTenstSM4QtbX146oSvJXVf14koVZU7"],
  [0x32, "M", "7d6f7dd374b82290f7214e897cfb60b062f5321b", "MKLQFyVLxZVTuPpHnmmYHmNe1JdoqaKgtf"],
  [0x1e, "D", "d748dab38023f1771ce8e828e9ac7f63a397348d", "DQmR6WPnC8nUWXwtUSsZaE2d4pFy8Ue9Z5"],
  [0x4c, "X", "1bd368bd279e55a34cf014fed7b4cd5491445d6c", "XdDyLPzPKDGwVuR3YRQgd1Fufe5fjwYWzH"],
  [0x00, "1", "dd98f5fc23e91d214c5a5beb84af6f80bf06d65c", "1MChaJZF4KZzLPxap2pe3QoBfo8Yj4J9Rd"],
  [0x05, "3", "402e2e5d38c8e9547486d2b84ad9647e54f481fa", "37YNVYK5QKVNAXc6BZJh5u8gD2Y5xPnYCm"],
  [0x41, "T", "d72c25db0fcd4ab1bc7cfab0964c706e98fc6078", "TVawAkVF8yWvFk5RpjzuoSS1BuyKc2HwHv"],
  [0x30, "L", "5fe208c0d084bedfa0abc7260b92ab384c7ff3e9", "LTxwEZtfu4yoy1VBb8TBGX9BwVH2qZNm3t"],
  [0x32, "M", "49fa80c5f266b09a3bc4d48b339543880308ac57", "MEeKeguPLHqPXgTt4ktUiFd6tEsnYGMqiZ"],
  [0x1e, "D", "107117eb5f5ffa0c209d8951015bdd0809e9630f", "D6e2qCQBxJCVaxqwhvMDFY4SUvis9yTh4t"],
  [0x4c, "X", "97b8f64fd642519ea68a28ff63162ca1c45ea885", "XpX5ScfaggFU2z9MZksmx5poeWAv1oRuE1"],
  [0x00, "1", "db385dedd9f607275c4b220b8720f0017a8797f0", "1Lz8WTF72QPnCcPY74gQECfy113eoLohco"],
  [0x05, "3", "647c7483e986bcd3600f73267d0eca82110a218d", "3ArLb2C8y7SHkmGeUU6dJNPAMBXDuWG34E"],
  [0x41, "T", "a47236573c9d08b81b8cb0360c838c1e4f87b126", "TQxie8JannMwZBcKgjXngz9w5EgfM5575E"],
  [0x30, "L", "723dab87ceaab9abb103a4aa3d197eece3f06f0a", "LVe1AzSpLNSV97qfQNUrY4QCNbQEBrZuaJ"],
  [0x32, "M", "643ab46ed2e22a9d74817c373359f7a1a75ed482", "MH388VgdWxsGq2XKFPueDemHSRVsxBK3GE"],
  [0x1e, "D", "e5f42258f6f320759f53c175f81cca8e58fd4a9e", "DS6yjvj4d1615pgNwjgNkNY5yTw8soUzM5"],
  [0x4c, "X", "152d85b672183e490b35a2b7dcb5f0d06e6b4b33", "XccpZEAbUx71Uyo5kTU7uGqMh3pae2oTDQ"],
  [0x00, "1", "ac41aadd2af2a68848d87aa16446fb8d8287a42b", "1Ghotec63R7X9hP1Eg9vWDF4sm6iGB5pmc"],
  [0x05, "3", "2f1a2fc71604dbc8ee9206538d76f8170bee020a", "35z543CvCoZDqgiaFVYjcuxZ8H6bnDLfPB"],
  [0x41, "T", "a777efb0c2ca20b78789079c36517568fdf66b66", "TREhXQyqfAhAgxfdxcH1oF6XhTbkgHLkew"],
  [0x30, "L", "852babe913f7d074f40cfa0f105fd338a71b2551", "LXN6T5S3pJRTssFJb8kYwv8wWDmNHwHMVV"],
  [0x32, "M", "cb831a3cc850ad5d8d05d6e91c3d9480c98006ed", "MSTETXqT5McYXsMPCsDidXj8obV9bEtmv7"],
  [0x1e, "D", "5301dddb2c1d922b13e47586f6079aa0af25046f", "DChzrskP9KDCcsH6jfexAP2JVLMBqHSTcs"],
  [0x4c, "X", "e33603692fd5a24d1f906cbe2d3a8f49e7ea507a", "XwQDviAMnXnLmaY2qtARdxXfWzYHtKkRuD"],
  [0x00, "1", "308bbe22dbe18688d73a422014148129ec88d3d5", "15RgqhjHBfGSJZvSA7dvYEetcPtUhfefon"],
  [0x05, "3", "9b3a8c60974fc7f313113d5fc71a6658ec9e7b3c", "3FqnoHfJZknrTndcVYY8ewJzf9rUz7iaMy"],
  [0x41, "T", "28a1500402dd5546b104e9db4cc46350108f9ebb", "TDg3GvdWKj27DusSgvkhdbCp8jQdgm3cEu"],
  [0x30, "L", "288380f8e07397f77bd7b99725726b221c373220", "LNvApvufzdLi2DhKkSE9awSFK5dJbfHoiS"],
  [0x32, "M", "eb36b6d1cf728ef173937e1b25ca6d6a46af2cea", "MVLra7eKJzwJfYFzqaxv5Y7KLbS8TF5grM"],
  [0x1e, "D", "02f80100e423b2d5b359cf917c8c5c7ceb10014d", "D5QnzFqG43jx992pa2L9bwZqYAKx5fykAZ"],
  [0x4c, "X", "6549c783dc05817b74df53a4bd5dace32046c144", "XjvQTucEVGfAQkx51nvAB3EcNg8SoifgFM"],
  [0x00, "1", "f22279057ae4004aa0102e2e36eca21f82f3c2c9", "1P5HpdbQm95HUCpLy8ZxQCZ2MX3ZRouwWk"],
  [0x05, "3", "1a9cc8d0e907d82b7f2e0ec8b9d2bd0fe66fbb09", "347jK73f4GhfPxGPZEgzTBr5ySu26xcuW7"],
  [0x41, "T", "336fe4574bc0e3ebab267a7508a058094bb48c2a", "TEfBWEQ6R3TZBNACEJZKos2zspfvcFi4v3"],
  [0x30, "L", "7e39d4a64947910bd69dd130a3fe9e3678aa78c0", "LWjNgXc9mxDi26G9hxtDMcgQ7wZ3HL1bB3"],
  [0x32, "M", "c86d5c92d6024d82d1c59fb390e474ff689a153b", "MSAvPNgBGipJkknoDw71ZtAo8YCoVj2M7h"],
  [0x1e, "D", "397a17c8f53208c956ab1832a76b8574a3cc9e2a", "DAP1KMepuCPKZMuEYMnjpTPvbHx6TG1gMT"],
  [0x4c, "X", "0f30bdfb21935fa6426ef45281e8507a47a65d7b", "Xc5AMnubrzsgtMGSMvxsV9TmFjbQVg5Fbu"],
  [0x00, "1", "4e7455cfafe48da50484c488e76b9fdbcb02025d", "189q55JbaowU3JizH6WnnmsKPJJ6Xya92i"],
  [0x05, "3", "c94003648b3ae46087e050c75f66857080332770", "3L38RpYGLRThqrpNrHzM8AhCxWhXye8L5A"],
];

// Python codecs.keccak256 (backend: pure-python; equals _keccak256_pure) of (bytes(range(256)) * 4)[:length]
const KECCAK_PY = {
  0: "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  1: "bc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a",
  134: "861e165162f806cd361c4421a48f205820ddf4deb02db9f041f48e179ddada97",
  135: "cbdfd9dee5faad3818d6b06f95a219fd290b0e1706f6a82e5a595b9ce9faca62",
  136: "7ce759f1ab7f9ce437719970c26b0a66ff11fe3e38e17df89cf5d29c7d7f807e",
  137: "ac73d4fae68b8453f764007c1a20ce95994187861f0c3227a3a8e99a73a3b1db",
  271: "7c974895b2a88303ff2dc6b58f438ceb0b298cac91099ac0539cc0f477506191",
  272: "fdf2ec49e749960d3c8521a0219af8d03e30e2b3bf19bd16150ee0eaf133d66e",
  1000: "aca79e4146e30eb1c733f6d6060d72471c36ea4e01ebf45d7f4916249c2bbd82",
};

// validate_wallet(chain, input).detail() for every validate call the Python suite makes
const PY_VALIDATE_REF = [
  {"chain": "btc", "input": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "valid": true, "canonical": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "key": "btc:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "format": "P2PKH (legacy)", "errors": [], "detected": {"chain": "btc", "candidates": ["btc", "bch"], "note": "Legacy format is shared by Bitcoin and Bitcoin Cash."}},
  {"chain": "btc", "input": "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "valid": true, "canonical": "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "key": "btc:3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "format": "P2SH", "errors": [], "detected": {"chain": "btc", "candidates": ["btc", "bch"], "note": "Legacy format is shared by Bitcoin and Bitcoin Cash."}},
  {"chain": "btc", "input": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "valid": true, "canonical": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "key": "btc:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "format": "SegWit v0 (Bech32)", "errors": [], "detected": {"chain": "btc", "candidates": ["btc"], "note": ""}},
  {"chain": "btc", "input": "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "valid": true, "canonical": "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "key": "btc:bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "format": "Taproot (Bech32m)", "errors": [], "detected": {"chain": "btc", "candidates": ["btc"], "note": ""}},
  {"chain": "eth", "input": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "valid": true, "canonical": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "key": "eth:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format": "EVM (EIP-55 checksum verified)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "eth", "input": "0xde709f2102306220921060314715629080e2fb77", "valid": true, "canonical": "0xde709f2102306220921060314715629080e2fb77", "key": "eth:0xde709f2102306220921060314715629080e2fb77", "format": "EVM (no checksum casing)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "eth", "input": "0x52908400098527886E0F7030069857D2E4169EE7", "valid": true, "canonical": "0x52908400098527886E0F7030069857D2E4169EE7", "key": "eth:0x52908400098527886e0f7030069857d2e4169ee7", "format": "EVM (no checksum casing)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "trx", "input": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "valid": true, "canonical": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "key": "trx:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "format": "Base58Check", "errors": [], "detected": {"chain": "trx", "candidates": ["trx"], "note": ""}},
  {"chain": "trx", "input": "TT3inhfvXSFGUduQW892uPSfnn5VyENm8i", "valid": true, "canonical": "TT3inhfvXSFGUduQW892uPSfnn5VyENm8i", "key": "trx:TT3inhfvXSFGUduQW892uPSfnn5VyENm8i", "format": "Base58Check", "errors": [], "detected": {"chain": "trx", "candidates": ["trx"], "note": ""}},
  {"chain": "ltc", "input": "Lgh8Qi8hWEF6PY6Tv6y2koLiL2CYbH7KZt", "valid": true, "canonical": "Lgh8Qi8hWEF6PY6Tv6y2koLiL2CYbH7KZt", "key": "ltc:Lgh8Qi8hWEF6PY6Tv6y2koLiL2CYbH7KZt", "format": "P2PKH (L…)", "errors": [], "detected": {"chain": "ltc", "candidates": ["ltc"], "note": ""}},
  {"chain": "ltc", "input": "M8WQyVconC1BbZggfsq8E7aES99zpJD1GT", "valid": true, "canonical": "M8WQyVconC1BbZggfsq8E7aES99zpJD1GT", "key": "ltc:M8WQyVconC1BbZggfsq8E7aES99zpJD1GT", "format": "P2SH (M…)", "errors": [], "detected": {"chain": "ltc", "candidates": ["ltc"], "note": ""}},
  {"chain": "ltc", "input": "ltc1q27sjschpsyd5ek4jzhwfxncuajcuygm2cx4crw", "valid": true, "canonical": "ltc1q27sjschpsyd5ek4jzhwfxncuajcuygm2cx4crw", "key": "ltc:ltc1q27sjschpsyd5ek4jzhwfxncuajcuygm2cx4crw", "format": "SegWit (Bech32)", "errors": [], "detected": {"chain": "ltc", "candidates": ["ltc"], "note": ""}},
  {"chain": "doge", "input": "DMbdCxam2TcV98DLfbcpfmi57sSrca8HBp", "valid": true, "canonical": "DMbdCxam2TcV98DLfbcpfmi57sSrca8HBp", "key": "doge:DMbdCxam2TcV98DLfbcpfmi57sSrca8HBp", "format": "P2PKH (D…)", "errors": [], "detected": {"chain": "doge", "candidates": ["doge"], "note": ""}},
  {"chain": "dash", "input": "Xjhdw9WcsBicZy2zk9fEaTvugEWiNKPK8X", "valid": true, "canonical": "Xjhdw9WcsBicZy2zk9fEaTvugEWiNKPK8X", "key": "dash:Xjhdw9WcsBicZy2zk9fEaTvugEWiNKPK8X", "format": "P2PKH (X…)", "errors": [], "detected": {"chain": "dash", "candidates": ["dash"], "note": ""}},
  {"chain": "bch", "input": "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "valid": true, "canonical": "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "key": "bch:bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "format": "CashAddr P2PKH", "errors": [], "detected": {"chain": "bch", "candidates": ["bch"], "note": ""}},
  {"chain": "bch", "input": "qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy", "valid": true, "canonical": "bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy", "key": "bch:bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy", "format": "CashAddr P2PKH", "errors": [], "detected": {"chain": "bch", "candidates": ["bch"], "note": ""}},
  {"chain": "bch", "input": "BITCOINCASH:QPM2QSZNHKS23Z7629MMS6S4CWEF74VCWVY22GDX6A", "valid": true, "canonical": "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "key": "bch:bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "format": "CashAddr P2PKH", "errors": [], "detected": {"chain": "bch", "candidates": ["bch"], "note": ""}},
  {"chain": "bch", "input": "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu", "valid": true, "canonical": "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "key": "bch:bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "format": "Legacy (converted to CashAddr)", "errors": [], "detected": {"chain": "btc", "candidates": ["btc", "bch"], "note": "Legacy format is shared by Bitcoin and Bitcoin Cash."}},
  {"chain": "ada", "input": "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x", "valid": true, "canonical": "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x", "key": "ada:addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x", "format": "Shelley base address", "errors": [], "detected": {"chain": "ada", "candidates": ["ada"], "note": ""}},
  {"chain": "ada", "input": "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8", "valid": true, "canonical": "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8", "key": "ada:addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8", "format": "Shelley enterprise address", "errors": [], "detected": {"chain": "ada", "candidates": ["ada"], "note": ""}},
  {"chain": "avax", "input": "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "valid": true, "canonical": "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "key": "avax:0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359", "format": "EVM (EIP-55 checksum verified)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "avax", "input": "X-avax13nauw3cnc9jwxwnungd0km9k4zxngnskz2l8vq", "valid": true, "canonical": "X-avax13nauw3cnc9jwxwnungd0km9k4zxngnskz2l8vq", "key": "avax:x-avax13nauw3cnc9jwxwnungd0km9k4zxngnskz2l8vq", "format": "Avalanche X-Chain (Bech32)", "errors": [], "detected": {"chain": "avax", "candidates": ["avax"], "note": "Avalanche X-Chain address"}},
  {"chain": "bsc", "input": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "valid": true, "canonical": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "key": "bsc:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format": "EVM (EIP-55 checksum verified)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "matic", "input": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "valid": true, "canonical": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "key": "matic:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format": "EVM (EIP-55 checksum verified)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "arb", "input": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "valid": true, "canonical": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "key": "arb:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format": "EVM (EIP-55 checksum verified)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "avax", "input": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "valid": true, "canonical": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "key": "avax:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format": "EVM (EIP-55 checksum verified)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "op", "input": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "valid": true, "canonical": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "key": "op:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format": "EVM (EIP-55 checksum verified)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "eth", "input": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Ethereum address: EIP-55 checksum mismatch — check for a typo in the mixed-case address."], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "eth", "input": "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "valid": true, "canonical": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "key": "eth:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format": "EVM (no checksum casing)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "bsc", "input": "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED", "valid": true, "canonical": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "key": "bsc:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "format": "EVM (no checksum casing)", "errors": [], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "bch", "input": "qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "valid": true, "canonical": "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "key": "bch:bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", "format": "CashAddr P2PKH", "errors": [], "detected": {"chain": "bch", "candidates": ["bch"], "note": ""}},
  {"chain": "btc", "input": "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "valid": true, "canonical": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "key": "btc:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "format": "SegWit v0 (Bech32)", "errors": [], "detected": {"chain": "btc", "candidates": ["btc"], "note": ""}},
  {"chain": "btc", "input": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Bitcoin address: Base58Check checksum mismatch."], "detected": {"chain": "btc", "candidates": ["btc", "bch"], "note": "Legacy format is shared by Bitcoin and Bitcoin Cash."}},
  {"chain": "btc", "input": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Bitcoin address: wrong version byte — expected an address starting with 1, 3 or bc1. It looks like a Tron (TRC-20) address."], "detected": {"chain": "trx", "candidates": ["trx"], "note": ""}},
  {"chain": "trx", "input": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Tron (TRC-20) address: expected 34 characters starting with T. It looks like a Bitcoin address."], "detected": {"chain": "btc", "candidates": ["btc", "bch"], "note": "Legacy format is shared by Bitcoin and Bitcoin Cash."}},
  {"chain": "trx", "input": "1QD9ZeBSiRUtybsLsi8LhQqRso4QX53KA1", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Tron (TRC-20) address: expected 34 characters starting with T. It looks like a Bitcoin address."], "detected": {"chain": "btc", "candidates": ["btc", "bch"], "note": "Legacy format is shared by Bitcoin and Bitcoin Cash."}},
  {"chain": "ltc", "input": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Litecoin address: wrong version byte — expected an address starting with L, M or ltc1. It looks like a Bitcoin address."], "detected": {"chain": "btc", "candidates": ["btc", "bch"], "note": "Legacy format is shared by Bitcoin and Bitcoin Cash."}},
  {"chain": "doge", "input": "DKjN45rmTjxsP4S2g9GijgFVRG3xBGrjJx", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Dogecoin address: Base58Check checksum mismatch."], "detected": {"chain": "doge", "candidates": ["doge"], "note": ""}},
  {"chain": "eth", "input": "0x123", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Ethereum address: expected 0x followed by 40 hexadecimal characters."], "detected": {"chain": null, "candidates": [], "note": ""}},
  {"chain": "eth", "input": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Ethereum address: expected 0x followed by 40 hexadecimal characters. It looks like a Tron (TRC-20) address."], "detected": {"chain": "trx", "candidates": ["trx"], "note": ""}},
  {"chain": "bch", "input": "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6q", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Bitcoin Cash address: CashAddr checksum mismatch."], "detected": {"chain": "bch", "candidates": ["bch"], "note": ""}},
  {"chain": "bch", "input": "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Bitcoin Cash address: invalid CashAddr character."], "detected": {"chain": "bch", "candidates": ["bch"], "note": ""}},
  {"chain": "ada", "input": "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl9", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Cardano address: Bech32 checksum mismatch."], "detected": {"chain": "ada", "candidates": ["ada"], "note": ""}},
  {"chain": "ada", "input": "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Cardano address: expected a mainnet Shelley address starting with addr1."], "detected": {"chain": null, "candidates": [], "note": ""}},
  {"chain": "avax", "input": "X-avax1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Avalanche address: Bech32 checksum mismatch."], "detected": {"chain": "avax", "candidates": ["avax"], "note": "Avalanche X-Chain address"}},
  {"chain": "btc", "input": "", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Enter a wallet address."], "detected": {"chain": null, "candidates": [], "note": ""}},
  {"chain": "btc", "input": "1A1zP1eP5QGefi2DMPT fTL5SLmv7DivfNa", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["The address contains spaces."], "detected": {"chain": null, "candidates": [], "note": ""}},
  {"chain": "xmr", "input": "4abc", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Unsupported chain 'xmr'."], "detected": {"chain": null, "candidates": [], "note": ""}},
  {"chain": "xrp", "input": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "valid": true, "canonical": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "key": "xrp:rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "format": "XRP Ledger classic address (Base58Check)", "errors": [], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}},
  {"chain": "xrp", "input": "rrrrrrrrrrrrrrrrrrrrrhoLvTp", "valid": true, "canonical": "rrrrrrrrrrrrrrrrrrrrrhoLvTp", "key": "xrp:rrrrrrrrrrrrrrrrrrrrrhoLvTp", "format": "XRP Ledger classic address (Base58Check)", "errors": [], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}},
  {"chain": "xrp", "input": "rrrrrrrrrrrrrrrrrrrrBZbvji", "valid": true, "canonical": "rrrrrrrrrrrrrrrrrrrrBZbvji", "key": "xrp:rrrrrrrrrrrrrrrrrrrrBZbvji", "format": "XRP Ledger classic address (Base58Check)", "errors": [], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}},
  {"chain": "xrp", "input": "rrrrrrrrrrrrrrrrrNAMEtxvNvQ", "valid": true, "canonical": "rrrrrrrrrrrrrrrrrNAMEtxvNvQ", "key": "xrp:rrrrrrrrrrrrrrrrrNAMEtxvNvQ", "format": "XRP Ledger classic address (Base58Check)", "errors": [], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}},
  {"chain": "xrp", "input": "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", "valid": true, "canonical": "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", "key": "xrp:rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", "format": "XRP Ledger classic address (Base58Check)", "errors": [], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}},
  {"chain": "xrp", "input": "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn", "valid": true, "canonical": "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn", "key": "xrp:rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn", "format": "XRP Ledger classic address (Base58Check)", "errors": [], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}},
  {"chain": "xrp", "input": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid XRP Ledger address: Base58Check checksum mismatch."], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}},
  {"chain": "xrp", "input": "X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid XRP Ledger address: X-addresses aren't accepted — enter the classic r… address and put the destination tag in its own field."], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP X-address — enter the classic r… address and the tag instead."}},
  {"chain": "xrp", "input": "rHb9CJAWyB4rj91VRWn96Dk", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid XRP Ledger address: expected a classic XRP Ledger address starting with r."], "detected": {"chain": null, "candidates": [], "note": ""}},
  {"chain": "xrp", "input": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid XRP Ledger address: expected a classic XRP Ledger address starting with r. It looks like a Ethereum address."], "detected": {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}},
  {"chain": "btc", "input": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "valid": false, "canonical": null, "key": null, "format": null, "errors": ["Not a valid Bitcoin address: Base58Check checksum mismatch. It looks like a XRP Ledger address."], "detected": {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}},
];

// detect_chain(input).as_dict() for every detect call the Python suite makes
const PY_DETECT_REF = [
  ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}],
  ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", {"chain": "btc", "candidates": ["btc", "bch"], "note": "Legacy format is shared by Bitcoin and Bitcoin Cash."}],
  ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", {"chain": "btc", "candidates": ["btc"], "note": ""}],
  ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", {"chain": "trx", "candidates": ["trx"], "note": ""}],
  ["LecPt32GnGCfgGdzRq1aNPqjvUxTkwKVAK", {"chain": "ltc", "candidates": ["ltc"], "note": ""}],
  ["ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9", {"chain": "ltc", "candidates": ["ltc"], "note": ""}],
  ["DCLtWZNyAeVfSNifrab2To8ejPZzYSeZ8C", {"chain": "doge", "candidates": ["doge"], "note": ""}],
  ["XjHsjEfKBr1nusHDPXqnarMcoKckhs87ft", {"chain": "dash", "candidates": ["dash"], "note": ""}],
  ["qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", {"chain": "bch", "candidates": ["bch"], "note": ""}],
  ["bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", {"chain": "bch", "candidates": ["bch"], "note": ""}],
  ["addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8", {"chain": "ada", "candidates": ["ada"], "note": ""}],
  ["X-avax1abc", {"chain": "avax", "candidates": ["avax"], "note": "Avalanche X-Chain address"}],
  ["hello", {"chain": null, "candidates": [], "note": ""}],
  ["", {"chain": null, "candidates": [], "note": ""}],
  ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}],
  ["rrrrrrrrrrrrrrrrrrrrrhoLvTp", {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}],
  ["rrrrrrrrrrrrrrrrrrrrBZbvji", {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}],
  ["rrrrrrrrrrrrrrrrrNAMEtxvNvQ", {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}],
  ["rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}],
  ["rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn", {"chain": "xrp", "candidates": ["xrp"], "note": "XRP Ledger address — a destination tag is required."}],
  ["0xabababababababababababababababababababab", {"chain": "eth", "candidates": ["eth", "bsc", "matic", "arb", "avax", "op"], "note": "0x addresses look identical on every EVM chain — pick the network the site actually uses."}],
  ["Xr1mkpfeXdqiwP3rJbyfRqSBffWTknQU9o", {"chain": "dash", "candidates": ["dash"], "note": ""}],
];

// A 32-byte key (sha256 of a fixed seed) whose Base58 form is 44 chars starting with D;
// Python's detect_chain calls it Dogecoin by first letter.
const SOL_D44 = { address: "Dq76ubZbdb7oHBBAqje1S1SNkiyPiak12RUTdbHCrLHr", hex: "be9f0575a53ab50e2585a44a38aea3b174923781eabab6305b5a437064cb1755", pythonDetection: {"chain": "doge", "candidates": ["doge"], "note": ""} };
// ---- end embedded block ----

// ------------------------------------------------------------ Python test data

const VALID = {
  btc: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'],
  eth: ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xde709f2102306220921060314715629080e2fb77',
    '0x52908400098527886E0F7030069857D2E4169EE7'],
  trx: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', SEEDED.trx_0x41], // b58(0x41)
  ltc: [SEEDED.ltc_0x30, SEEDED.ltc_0x32, SEEDED.ltc_segwit], // b58(0x30), b58(0x32), segwit_encode("ltc", 0, _hash20())
  doge: [SEEDED.doge_0x1e], // b58(0x1E)
  dash: [SEEDED.dash_0x4c], // b58(0x4C)
  bch: ['bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy',
    'BITCOINCASH:QPM2QSZNHKS23Z7629MMS6S4CWEF74VCWVY22GDX6A', '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu'],
  ada: ['addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
    'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8'],
  avax: ['0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    SEEDED.avax_x], // "X-" + bech32_encode("avax", convertbits(_hash20(), 8, 5), "bech32")
};

const INVALID = [
  ['btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'checksum'],
  ['btc', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'looks like a Tron'],
  ['trx', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '34 characters'],
  ['trx', SEEDED.trx_invalid_from_0x00, ''], // b58(0x00)[:33] + "1"
  ['ltc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'version'],
  ['doge', SEEDED.doge_invalid_typo, ''], // b58(0x1E)[:-1] + "x"
  ['eth', '0x123', '40 hexadecimal'],
  ['eth', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'looks like a Tron'],
  ['bch', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6q', 'checksum'],
  ['bch', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b', 'character'],
  ['ada', 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl9', 'checksum'],
  ['ada', 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz', ''],
  ['avax', 'X-avax1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', ''],
  ['btc', '', 'Enter a wallet'],
  ['btc', '1A1zP1eP5QGefi2DMPT fTL5SLmv7DivfNa', 'spaces'],
  ['xmr', '4abc', 'Unsupported'],
];

const DETECTION = [
  ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'eth', EVM_CHAINS], // Python: its EVM_CHAINS; JS adds "base"
  ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'btc', ['btc', 'bch']],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'btc', ['btc']],
  ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'trx', ['trx']],
  [SEEDED.det_ltc_0x30, 'ltc', ['ltc']], // b58(0x30)
  ['ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9', 'ltc', ['ltc']],
  [SEEDED.det_doge_0x1e, 'doge', ['doge']], // b58(0x1E)
  [SEEDED.det_dash_0x4c, 'dash', ['dash']], // b58(0x4C)
  ['qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'bch', ['bch']],
  ['bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'bch', ['bch']],
  ['addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8', 'ada', ['ada']],
  ['X-avax1abc', 'avax', ['avax']],
  ['hello', null, []],
  ['', null, []],
];

// ------------------------------------------------- PortedWalletTests (test_wallets.py)

describe('PortedWalletTests', () => {
  describe('test_valid_addresses', () => {
    for (const [chain, addresses] of Object.entries(VALID)) {
      for (const address of addresses) {
        it(`${chain} ${address}`, () => {
          const check = W.validateWallet(chain, address);
          assert.ok(check.valid, check.errors.join(' | '));
          assert.ok(check.key.startsWith(chain + ':'), check.key);
        });
      }
    }
  });

  describe('test_every_evm_chain_accepts_0x', () => {
    for (const chain of EVM_CHAINS) {
      it(chain, () => assert.ok(W.validateWallet(chain, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').valid));
    }
  });

  it('test_evm_checksum_typo_rejected', () => {
    const check = W.validateWallet('eth', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'); // last char case flipped
    assert.equal(check.valid, false);
    assert.ok(check.errors[0].includes('EIP-55'), check.errors[0]);
  });

  it('test_evm_canonical_and_per_chain_keys', () => {
    const lower = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
    const eth = W.validateWallet('eth', lower);
    const bsc = W.validateWallet('bsc', lower.toUpperCase().replace('0X', '0x'));
    assert.equal(eth.canonical, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    assert.deepEqual([eth.key, bsc.key], ['eth:' + lower, 'bsc:' + lower]);
  });

  it('test_bch_legacy_and_cashaddr_share_a_key', () => {
    const legacy = W.validateWallet('bch', '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu');
    const cash = W.validateWallet('bch', 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
    assert.equal(legacy.canonical, 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
    assert.equal(legacy.canonical, cash.canonical);
    assert.equal(legacy.key, cash.key);
  });

  it('test_base58_keys_are_case_sensitive_bech32_keys_are_not', () => {
    assert.equal(W.validateWallet('btc', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4').key,
      'btc:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    assert.equal(W.validateWallet('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').key,
      'btc:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  });

  describe('test_invalid_addresses', () => {
    for (const [chain, address, fragment] of INVALID) {
      it(`${chain} ${JSON.stringify(address)} -> ${JSON.stringify(fragment)}`, () => {
        const check = W.validateWallet(chain, address);
        assert.equal(check.valid, false);
        assert.ok(joined(check).includes(fragment), joined(check));
      });
    }
  });

  it('test_every_generated_version_byte_starts_with_documented_letter', () => {
    assert.equal(GENERATED.length, 50 * 7);
    for (const [version, letter, hash160, pythonAddress] of GENERATED) {
      const address = C.b58checkEncode(Uint8Array.of(version, ...fromHex(hash160)));
      assert.equal(address, pythonAddress, `b58(0x${version.toString(16)}) of ${hash160}`);
      assert.ok(address.startsWith(letter), `${address} should start with ${letter}`);
    }
  });

  describe('test_detection', () => {
    for (const [address, chain, candidates] of DETECTION) {
      it(JSON.stringify(address), () => {
        const detection = W.detectChain(address);
        assert.equal(detection.chain, chain);
        assert.deepEqual([...detection.candidates], [...candidates]);
      });
    }
  });

  it('test_evm_detection_explains_ambiguity', () => {
    assert.ok(W.detectChain('0x' + 'ab'.repeat(20)).note.includes('every EVM chain'));
  });

  it('test_detail_is_json_serializable', () => {
    const check = W.validateWallet('eth', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    const text = JSON.stringify(check);
    assert.deepEqual(JSON.parse(text), check);
    for (const field of ['chain', 'input', 'valid', 'canonical', 'key', 'format', 'errors', 'detected']) {
      assert.ok(field in JSON.parse(text), field);
    }
    assert.deepEqual(Object.keys(JSON.parse(text).detected).sort(), ['candidates', 'chain', 'note']);
  });
});

// ---------------------------------------------- PortedCodecTests (test_codecs.py)

describe('PortedCodecTests', () => {
  it('test_keccak256_vectors', () => {
    assert.equal(C.hex(C.keccak256(new Uint8Array(0))), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    assert.equal(C.hex(C.keccak256(ascii('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  });

  describe('test_keccak_pure_matches_backend_across_block_boundaries (JS vs Python output)', () => {
    const data = new Uint8Array(1024).map((_, i) => i % 256); // bytes(range(256)) * 4
    for (const length of [0, 1, 134, 135, 136, 137, 271, 272, 1000]) {
      it(`length ${length}`, () => assert.equal(C.hex(C.keccak256(data.slice(0, length))), KECCAK_PY[length]));
    }
  });

  it('test_eip55_vectors', () => {
    for (const address of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
      assert.equal(C.eip55Checksum(address.slice(2)), address);
      assert.equal(C.eip55Checksum(address.slice(2).toLowerCase()), address);
    }
  });

  describe('test_base58check_vectors', () => {
    for (const [address, version] of [['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 0x00], ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 0x00],
      ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 0x05], ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 0x41]]) {
      it(address, () => {
        const payload = C.b58checkDecode(address);
        assert.deepEqual([payload[0], payload.length], [version, 21]);
        assert.equal(C.b58checkEncode(payload), address);
      });
    }
  });

  it('test_base58check_rejects_typo', () => {
    for (const text of ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', '0OIl']) {
      assert.throws(() => C.b58checkDecode(text), DecodeError, text);
    }
  });

  describe('test_segwit_vectors', () => {
    for (const [address, version, prefix] of [
      ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 0, '751e76e8'],
      ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 0, '1863143c'],
      ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 1, '79be667e'],
    ]) {
      it(address, () => {
        const [gotVersion, program] = C.segwitDecode('bc', address);
        assert.equal(gotVersion, version);
        assert.ok(C.hex(program).startsWith(prefix), C.hex(program));
        assert.equal(C.segwitEncode('bc', gotVersion, program), address.toLowerCase());
      });
    }
  });

  describe('test_segwit_rejections', () => {
    for (const address of ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5',
      'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx']) {
      it(address, () => assert.throws(() => C.segwitDecode('bc', address), DecodeError));
    }
  });

  describe('test_cashaddr_vectors', () => {
    for (const [legacy, cashaddr] of [
      ['1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
      ['1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR', 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy'],
      ['3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC', 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq'],
    ]) {
      it(`${legacy} <-> ${cashaddr}`, () => {
        const payload = C.b58checkDecode(legacy);
        const addrType = payload[0] === 0x00 ? 0 : 1;
        assert.equal(C.cashaddrEncode('bitcoincash', addrType, payload.slice(1)), cashaddr);
        assert.deepEqual(C.cashaddrDecode(cashaddr), ['bitcoincash', addrType, payload.slice(1)]);
        assert.deepEqual(C.cashaddrDecode(cashaddr.split(':')[1]), ['bitcoincash', addrType, payload.slice(1)]);
        assert.throws(() => C.cashaddrDecode(cashaddr.slice(0, -1) + (cashaddr.at(-1) !== 'q' ? 'q' : 'p')), DecodeError);
      });
    }
  });

  describe('test_cardano_bech32_vectors', () => {
    for (const [address, header, length] of [
      ['addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x', 0x01, 57],
      ['addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8', 0x61, 29],
    ]) {
      it(address, () => {
        const [hrp, data, spec] = C.bech32Decode(address, 1023);
        const payload = C.convertbits(data, 5, 8, false);
        assert.deepEqual([hrp, spec, payload[0], payload.length], ['addr', 'bech32', header, length]);
      });
    }
  });
});

// ------------------------------------------------------------------ XrpTests

const XRP_VALID = [
  'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', // genesis account
  'rrrrrrrrrrrrrrrrrrrrrhoLvTp', // ACCOUNT_ZERO
  'rrrrrrrrrrrrrrrrrrrrBZbvji', // ACCOUNT_ONE
  'rrrrrrrrrrrrrrrrrNAMEtxvNvQ', // name-reservation black hole
  'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', // XRPL documentation examples
  'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn',
];

describe('XrpTests', () => {
  it('test_encoding_reproduces_the_published_special_accounts', () => {
    const toXrp = s => translate(s, B58_ALPHABET, W.XRP_ALPHABET);
    assert.equal(toXrp(C.b58checkEncode(new Uint8Array(21))), 'rrrrrrrrrrrrrrrrrrrrrhoLvTp');
    assert.equal(toXrp(C.b58checkEncode(Uint8Array.of(...new Uint8Array(20), 0x01))), 'rrrrrrrrrrrrrrrrrrrrBZbvji');
  });

  describe('test_valid_addresses_are_detected_and_accepted', () => {
    for (const address of XRP_VALID) {
      it(address, () => {
        const check = W.validateWallet('xrp', address);
        assert.ok(check.valid, check.errors.join(' | '));
        assert.deepEqual([check.canonical, check.key], [address, 'xrp:' + address]);
        assert.equal(W.detectChain(address).chain, 'xrp');
        assert.ok(W.detectChain(address).note.includes('destination tag'));
      });
    }
  });

  describe('test_rejections', () => {
    for (const [address, fragment] of [
      ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi', 'checksum'], // last char changed
      ['X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ', 'X-addresses'], // tag-embedding format
      ['rHb9CJAWyB4rj91VRWn96Dk', 'starting with r'], // too short
      ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'looks like a Ethereum'],
    ]) {
      it(`${address} -> ${fragment}`, () => {
        const check = W.validateWallet('xrp', address);
        assert.equal(check.valid, false);
        assert.ok(joined(check).includes(fragment), joined(check));
      });
    }
  });

  it('test_xrp_address_on_another_chain_is_blocked', () => {
    const check = W.validateWallet('btc', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
    assert.equal(check.valid, false);
    assert.ok(check.errors[0].includes('looks like a XRP Ledger'), check.errors[0]);
  });

  it('test_dash_and_tron_are_not_mistaken_for_x_addresses', () => {
    assert.equal(W.detectChain(SEEDED.runtime_dash_0x4c).chain, 'dash'); // b58(0x4C) at run time
    assert.equal(W.detectChain('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').chain, 'trx');
  });

  describe('test_destination_tag_is_required_and_bounded', () => {
    it('accepted tags', () => {
      assert.deepEqual(W.validateXrpDestTag('12345'), ['12345', null]);
      assert.deepEqual(W.validateXrpDestTag(' 007 '), ['7', null]);
      assert.deepEqual(W.validateXrpDestTag('4294967295'), ['4294967295', null]);
    });
    for (const bad of ['', '   ', '-1', '1.5', 'abc', '4294967296', '\uff11\uff12'] /* fullwidth '１２' */) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        const [value, error] = W.validateXrpDestTag(bad);
        assert.equal(value, null);
        assert.ok(error);
      });
    }
  });

  it('test_chain_list (Python set plus documented additions base, sol, ton)', () => {
    assert.deepEqual(new Set(Object.keys(W.CHAINS)), new Set([...PY_CHAINS, ...CHAIN_ADDITIONS]));
    assert.deepEqual([...W.EVM_CHAINS], EVM_CHAINS);
  });
});

// ------------------------------- Python parity: the reference's own outputs, field by field

describe('Python parity (embedded validate_wallet / detect_chain outputs)', () => {
  describe('validate_wallet(chain, input).detail()', () => {
    for (const ref of PY_VALIDATE_REF) {
      it(`${ref.chain} ${JSON.stringify(ref.input)}`, () => {
        assert.deepEqual(pyFields(W.validateWallet(ref.chain, ref.input)), { ...ref, detected: adjustDetection(ref.detected) });
      });
    }
  });
  describe('detect_chain(input)', () => {
    for (const [input, ref] of PY_DETECT_REF) {
      it(JSON.stringify(input), () => assert.deepEqual(W.detectChain(input), adjustDetection(ref)));
    }
  });
});

// ------------------------------------------------------- documented additions

describe('Addition: Base (EVM)', () => {
  it('accepts a checksummed 0x address with a base: key', () => {
    const check = W.validateWallet('base', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    assert.ok(check.valid, check.errors.join(' | '));
    assert.equal(check.canonical, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    assert.equal(check.key, 'base:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
    assert.equal(check.format, 'EVM (EIP-55 checksum verified)');
  });
  it('rejects a checksum typo like every EVM chain', () => {
    const check = W.validateWallet('base', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD');
    assert.equal(check.valid, false);
    assert.ok(check.errors[0].includes('EIP-55'));
  });
  it('is offered as a 0x candidate', () => {
    assert.ok(W.detectChain('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').candidates.includes('base'));
  });
});

describe('Addition: Solana', () => {
  const SOL_NOTE = 'Solana addresses have no checksum; only the length is verified.';
  for (const address of [SOL_D44.address, 'So11111111111111111111111111111111111111112']) {
    it(`accepts the 32-byte key ${address}`, () => {
      assert.equal(C.b58decode(address).length, 32);
      const check = W.validateWallet('sol', address);
      assert.ok(check.valid, check.errors.join(' | '));
      assert.equal(check.canonical, address);
      assert.equal(check.key, 'sol:' + address);
      assert.equal(check.format, 'Solana (32-byte key, no checksum)');
      assert.equal(check.checksum, false);
    });
  }
  it('the embedded D… key decodes to its 32 bytes', () => {
    assert.equal(C.hex(C.b58decode(SOL_D44.address)), SOL_D44.hex);
    assert.equal(C.b58encode(fromHex(SOL_D44.hex)), SOL_D44.address);
  });
  it('rejects a string that decodes to fewer than 32 bytes', () => {
    const address = '2'.repeat(32); // 23 bytes
    assert.equal(C.b58decode(address).length, 23);
    const check = W.validateWallet('sol', address);
    assert.equal(check.valid, false);
    assert.deepEqual(check.errors, ['Not a valid Solana address: does not decode to a 32-byte public key.']);
  });
  it('rejects a string that decodes to more than 32 bytes', () => {
    const address = 'z'.repeat(44); // 33 bytes
    assert.equal(C.b58decode(address).length, 33);
    const check = W.validateWallet('sol', address);
    assert.equal(check.valid, false);
    assert.deepEqual(check.errors, ['Not a valid Solana address: does not decode to a 32-byte public key.']);
  });
  it('rejects lengths outside 32..44 characters', () => {
    for (const address of ['2'.repeat(31), 'z'.repeat(45)]) {
      assert.deepEqual(W.validateWallet('sol', address).errors, ['Not a valid Solana address: expected 32 to 44 Base58 characters.']);
    }
  });
  it('a 44-character key starting with D is detected as sol (Python: doge by first letter)', () => {
    assert.ok(SOL_D44.address.startsWith('D') && SOL_D44.address.length === 44);
    assert.equal(SOL_D44.pythonDetection.chain, 'doge'); // the documented deviation
    assert.deepEqual(W.detectChain(SOL_D44.address), { chain: 'sol', candidates: ['sol'], note: SOL_NOTE });
    const doge = W.validateWallet('doge', SOL_D44.address);
    assert.equal(doge.valid, false);
    assert.deepEqual(doge.errors, ['Not a valid Dogecoin address: Base58Check checksum mismatch. It looks like a Solana address.']);
  });
});

describe('Addition: TON', () => {
  // Independent bitwise CRC-16/XMODEM (poly 0x1021, init 0, MSB first) to build test addresses.
  function crc16(bytes) {
    let crc = 0;
    for (const byte of bytes) {
      for (let bit = 7; bit >= 0; bit--) {
        const feedback = ((crc >> 15) & 1) ^ ((byte >> bit) & 1);
        crc = (crc << 1) & 0xffff;
        if (feedback) crc ^= 0x1021;
      }
    }
    return crc;
  }
  // Deterministic "random" 32-byte account hash (xorshift32).
  function hash32(seed) {
    let s = seed >>> 0;
    return Uint8Array.from({ length: 32 }, () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s & 0xff;
    });
  }
  // User-friendly form: base64url(flags | workchain | hash[32] | crc16 big-endian).
  function tonAddress(flags, workchain, hash) {
    const raw = new Uint8Array(36);
    raw[0] = flags;
    raw[1] = workchain & 0xff;
    raw.set(hash, 2);
    const crc = crc16(raw.subarray(0, 34));
    raw[34] = crc >> 8;
    raw[35] = crc & 0xff;
    return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_');
  }
  const FORMATS = { 0x11: 'bounceable TON address (CRC16 verified)', 0x51: 'non-bounceable TON address (CRC16 verified)' };

  it('CRC16-XMODEM check value (independent and wallets.js)', () => {
    assert.equal(crc16(ascii('123456789')), 0x31c3);
    assert.equal(C.crc16xmodem(ascii('123456789')), 0x31c3);
  });

  for (const [workchain, seed] of [[0, 0x1337], [-1, 0xbeef]]) {
    const hash = hash32(seed);
    for (const [flags, prefix] of [[0x11, workchain === 0 ? 'EQ' : 'Ef'], [0x51, workchain === 0 ? 'UQ' : 'Uf']]) {
      const address = tonAddress(flags, workchain, hash);
      it(`accepts flags 0x${flags.toString(16)} workchain ${workchain}: ${address}`, () => {
        assert.ok(address.startsWith(prefix) && address.length === 48, address);
        const check = W.validateWallet('ton', address);
        assert.ok(check.valid, check.errors.join(' | '));
        assert.equal(check.canonical, address);
        assert.equal(check.format, FORMATS[flags]);
        assert.equal(check.key, `ton:${workchain}:${C.hex(hash)}`);
        assert.equal(check.checksum, true);
        assert.deepEqual(W.detectChain(address), { chain: 'ton', candidates: ['ton'], note: '' });
      });
    }
  }

  it('bounceable and non-bounceable forms of one account share a key', () => {
    const hash = hash32(42);
    assert.equal(W.validateWallet('ton', tonAddress(0x11, 0, hash)).key, W.validateWallet('ton', tonAddress(0x51, 0, hash)).key);
  });

  it('one changed character -> checksum mismatch', () => {
    const address = tonAddress(0x11, 0, hash32(0x1337));
    assert.ok(W.validateWallet('ton', address).valid);
    for (const pos of [5, 20, 40]) {
      const flipped = address.slice(0, pos) + (address[pos] === 'A' ? 'B' : 'A') + address.slice(pos + 1);
      const check = W.validateWallet('ton', flipped);
      assert.equal(check.valid, false, flipped);
      assert.deepEqual(check.errors, ['Not a valid TON address: TON checksum mismatch.']);
    }
  });

  it('testnet flag 0x80 is rejected', () => {
    for (const flags of [0x91, 0xd1]) {
      const address = tonAddress(flags, 0, hash32(7));
      const check = W.validateWallet('ton', address);
      assert.equal(check.valid, false, address);
      assert.ok(check.errors.length === 1, joined(check));
    }
  });
});

// ------------------------------- extra Python-parity checks (not in the Python suite)

describe('Extra parity: chain codes inherited from Object.prototype are unsupported (Python: not in CHAINS)', () => {
  for (const chain of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    it(chain, () => {
      const check = W.validateWallet(chain, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
      assert.equal(check.valid, false);
      assert.deepEqual(check.errors, [`Unsupported chain '${chain}'.`]);
    });
  }
});

describe('Extra parity: whitespace follows Python str.strip()/str.isspace()', () => {
  const A = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const E = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  for (const [name, ws] of [['\\x1c', '\x1c'], ['\\x1f', '\x1f'], ['\\x85', '\x85']]) {
    it(`${name} around an address is stripped (Python: valid)`, () => {
      const check = W.validateWallet('btc', ws + A + ws);
      assert.equal(check.input, A);
      assert.equal(check.valid, true, check.errors.join(' | '));
      assert.equal(W.detectChain(ws + E + ws).chain, 'eth');
    });
    it(`${name} inside an address counts as a space`, () => {
      assert.deepEqual(W.validateWallet('btc', A.slice(0, 10) + ws + A.slice(10)).errors, ['The address contains spaces.']);
    });
    it(`${name} around a destination tag is stripped`, () => {
      assert.deepEqual(W.validateXrpDestTag(ws + '12' + ws), ['12', null]);
    });
  }
  it('U+FEFF is not whitespace in Python: kept, and the address is rejected', () => {
    const check = W.validateWallet('btc', '\ufeff' + A + '\ufeff');
    assert.equal(check.input, '\ufeff' + A + '\ufeff');
    assert.equal(check.valid, false);
    assert.deepEqual(check.errors, ['Not a valid Bitcoin address: expected a Base58 address starting with 1, 3 or bc1.']);
    assert.deepEqual(W.validateWallet('btc', A.slice(0, 10) + '\ufeff' + A.slice(10)).errors,
      ['Not a valid Bitcoin address: expected a Base58 address starting with 1, 3 or bc1.']);
    assert.deepEqual(W.validateXrpDestTag('\ufeff5'), [null, 'A destination tag is a whole number (digits only).']);
  });
});
