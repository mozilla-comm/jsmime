define(function(require) {
  return {
    MimeParser: require('./mimeparser'),
    headerparser: require('./headerparser'),
    headeremitter: require('./headeremitter')
  }
});
