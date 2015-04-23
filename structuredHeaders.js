/**
 * This file implements knowledge of how to encode or decode structured headers
 * for several key headers. It is not meant to be used externally to jsmime.
 */

define(function (require) {
"use strict";

var structuredDecoders = new Map();
var structuredEncoders = new Map();
var preferredSpellings = new Map();

function addHeader(name, decoder, encoder) {
  var lowerName = name.toLowerCase();
  structuredDecoders.set(lowerName, decoder);
  structuredEncoders.set(lowerName, encoder);
  preferredSpellings.set(lowerName, name);
}


// Addressing headers: We assume that they can be specified in 1* form (this is
// false for From, but it's close enough to the truth that it shouldn't matter).
// There is no need to specialize the results for the header, so just pun it
// back to parseAddressingHeader.
function parseAddress(value) {
  let results = [];
  let headerparser = this;
  return value.reduce(function (results, header) {
    return results.concat(headerparser.parseAddressingHeader(header, true));
  }, []);
}
function writeAddress(value) {
  // Make sure the input is an array (accept a single entry)
  if (!Array.isArray(value))
    value = [value];
  this.addAddresses(value);
}

// Addressing headers from RFC 5322:
addHeader("Bcc", parseAddress, writeAddress);
addHeader("Cc", parseAddress, writeAddress);
addHeader("From", parseAddress, writeAddress);
addHeader("Reply-To", parseAddress, writeAddress);
addHeader("Resent-Bcc", parseAddress, writeAddress);
addHeader("Resent-Cc", parseAddress, writeAddress);
addHeader("Resent-From", parseAddress, writeAddress);
addHeader("Resent-Reply-To", parseAddress, writeAddress);
addHeader("Resent-Sender", parseAddress, writeAddress);
addHeader("Resent-To", parseAddress, writeAddress);
addHeader("Sender", parseAddress, writeAddress);
addHeader("To", parseAddress, writeAddress);
// From RFC 5536:
addHeader("Approved", parseAddress, writeAddress);
// From RFC 3798:
addHeader("Disposition-Notification-To", parseAddress, writeAddress);
// Non-standard headers:
addHeader("Delivered-To", parseAddress, writeAddress);
addHeader("Return-Receipt-To", parseAddress, writeAddress);

// http://cr.yp.to/proto/replyto.html
addHeader("Mail-Reply-To", parseAddress, writeAddress);
addHeader("Mail-Followup-To", parseAddress, writeAddress);

// Parameter-based headers. Note that all parameters are slightly different, so
// we use slightly different variants here.
function parseParameterHeader(value, do2231, do2047) {
  // Only use the first header for parameters; ignore subsequent redefinitions.
  return this.parseParameterHeader(value[0], do2231, do2047);
}

// RFC 2045
function parseContentType(value) {
  let params = parseParameterHeader.call(this, value, false, false);
  let origtype = params.preSemi;
  let parts = origtype.split('/');
  if (parts.length != 2) {
    // Malformed. Return to text/plain. Evil, ain't it?
    params = new Map();
    parts = ["text", "plain"];
  }
  let mediatype = parts[0].toLowerCase();
  let subtype = parts[1].toLowerCase();
  let type = mediatype + '/' + subtype;
  let structure = new Map();
  structure.mediatype = mediatype;
  structure.subtype = subtype;
  structure.type = type;
  params.forEach(function (value, name) {
    structure.set(name.toLowerCase(), value);
  });
  return structure;
}
structuredDecoders.set("Content-Type", parseContentType);

// Unstructured headers (just decode RFC 2047 for the first header value)
function parseUnstructured(values) {
  return this.decodeRFC2047Words(values[0]);
}
function writeUnstructured(value) {
  this.addUnstructured(value);
}

// Message-ID headers.
function parseMessageID(values) {
  // TODO: Proper parsing support for these headers is currently unsupported).
  return this.decodeRFC2047Words(values[0]);
}
function writeMessageID(value) {
  // TODO: Proper parsing support for these headers is currently unsupported).
  this.addUnstructured(value);
}

// RFC 5322
addHeader("Comments", parseUnstructured, writeUnstructured);
addHeader("Keywords", parseUnstructured, writeUnstructured);
addHeader("Subject", parseUnstructured, writeUnstructured);

// RFC 2045
addHeader("MIME-Version", parseUnstructured, writeUnstructured);
addHeader("Content-Description", parseUnstructured, writeUnstructured);

// RFC 7231
addHeader("User-Agent", parseUnstructured, writeUnstructured);

// Date headers
function parseDate(values) { return this.parseDateHeader(values[0]); }
function writeDate(value) { this.addDate(value); }

// RFC 5322
addHeader("Date", parseDate, writeDate);
addHeader("Resent-Date", parseDate, writeDate);
// RFC 5536
addHeader("Expires", parseDate, writeDate);
addHeader("Injection-Date", parseDate, writeDate);
addHeader("NNTP-Posting-Date", parseDate, writeDate);

// RFC 5322
addHeader("Message-ID", parseMessageID, writeMessageID);
addHeader("Resent-Message-ID", parseMessageID, writeMessageID);

// Miscellaneous headers (those that don't fall under the above schemes):

// RFC 2047
structuredDecoders.set("Content-Transfer-Encoding", function (values) {
  return values[0].toLowerCase();
});
structuredEncoders.set("Content-Transfer-Encoding", writeUnstructured);

return Object.freeze({
  decoders: structuredDecoders,
  encoders: structuredEncoders,
  spellings: preferredSpellings,
});

});
