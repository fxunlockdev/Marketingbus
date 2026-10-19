exports.scrapeOptions = { parse(options) {
  if (options.proxy !== "basic" || options.skipTlsVerification !== false || options.timeout !== 1000
    || JSON.stringify(options.formats) !== '["markdown"]' || options.onlyMainContent !== true || options.maxAge !== 0) {
    throw Error("Private profile was not applied");
  }
  return options;
} };
