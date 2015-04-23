define(function(require) {
/**
 * This module implements the code for emitting structured representations of
 * MIME headers into their encoded forms. The code here is a companion to,
 * but completely independent of, jsmime.headerparser: the structured
 * representations that are used as input to the functions in this file are the
 * same forms that would be parsed.
 */

"use strict";

var mimeutils = require('./mimeutils');

// Get the default structured encoders and add them to the map
var structuredHeaders = require('./structuredHeaders');
var encoders = new Map();
var preferredSpellings = structuredHeaders.spellings;
for (let [header, encoder] of structuredHeaders.encoders) {
  addStructuredEncoder(header, encoder);
}

/// Clamp a value in the range [min, max], defaulting to def if it is undefined.
function clamp(value, min, max, def) {
  if (value === undefined)
    return def;
  if (value < min)
    return min;
  if (value > max)
    return max;
  return value;
}

/**
 * An object that can assemble structured header representations into their MIME
 * representation.
 *
 * The character-counting portion of this class operates using individual JS
 * characters as its representation of logical character, which is not the same
 * as the number of octets used as UTF-8. If non-ASCII characters are to be
 * included in headers without some form of encoding, then care should be taken
 * to set the maximum line length to account for the mismatch between character
 * counts and octet counts: the maximum line is 998 octets, which could be as
 * few as 332 JS characters (non-BMP characters, although they take up 4 octets
 * in UTF-8, count as 2 in JS strings).
 *
 * This code takes care to only insert line breaks at the higher-level breaking
 * points in a header (as recommended by RFC 5322), but it may need to resort to
 * including them more aggressively if this is not possible. If even aggressive
 * line-breaking cannot allow a header to be emitted without violating line
 * length restrictions, the methods will throw an exception to indicate this
 * situation.
 *
 * In general, this code does not attempt to modify its input; for example, it
 * does not attempt to change the case of any input characters, apply any
 * Unicode normalization algorithms, or convert email addresses to ACE where
 * applicable. The biggest exception to this rule is that most whitespace is
 * collapsed to a single space, even in unstructured headers, while most leading
 * and trailing whitespace is trimmed from inputs.
 *
 * @param {StreamHandler} handler The handler to which all output is sent.
 *   @param {Function(String)} handler.deliverData Receives encoded data.
 *   @param {Function()} handler.deliverEOF Sent when all text is sent.
 * @param {Object} options Options for the emitter.
 *   @param [options.softMargin=78] {30 <= Integer <= 900}
 *     The ideal maximum number of logical characters to include in a line, not
 *     including the final CRLF pair. Lines may exceed this margin if parameters
 *     are excessively long.
 *   @param [options.hardMargin=332] {softMargin <= Integer <= 998}
 *     The maximum number of logical characters that can be included in a line,
 *     not including the final CRLF pair. If this count would be exceeded, then
 *     an error will be thrown and encoding will not be possible.
 *   @param [options.useASCII=true] {Boolean}
 *     If true, then RFC 2047 and RFC 2231 encoding of headers will be performed
 *     as needed to retain headers as ASCII.
 */
function HeaderEmitter(handler, options) {
  /// The inferred value of options.useASCII
  this._useASCII = options.useASCII === undefined ? true : options.useASCII;
  /// The handler to use.
  this._handler = handler;
  /**
   * The current line being built; note that we may insert a line break in the
   * middle to keep under the maximum line length.
   *
   * @type String
   * @private
   */
  this._currentLine = "";

  // Our bounds for soft and margins are not completely arbitrary. The minimum
  // amount we need to encode is 20 characters, which can encode a single
  // non-BMP character with RFC 2047. The value of 30 is chosen to give some
  // breathing room for delimiters or other unbreakable characters. The maximum
  // length is 998 octets, per RFC 5322; soft margins are slightly lower to
  // allow for breathing room as well. The default of 78 for the soft margin is
  // recommended by RFC 5322; the default of 332 for the hard margin ensures
  // that UTF-8 encoding the output never violates the 998 octet limit.
  this._softMargin = clamp(options.softMargin, 30, 900, 78);
  this._hardMargin = clamp(options.hardMargin, this._softMargin, 998, 332);

  /**
   * The index of the last preferred breakable position in the current line.
   *
   * @type Integer
   * @private
   */
  this._preferredBreakpoint = 0;
}


///////////////////////
// Low-level methods //
///////////////////////

// Explanation of the emitter internals:
// RFC 5322 requires that we wrap our lines, ideally at 78 characters and at
// least by 998 octets. We can't wrap in arbitrary places, but wherever CFWS is
// valid... and ideally wherever clients are likely to expect it. In theory, we
// can break between every token (this is how RFC 822 operates), but, in RFC
// 5322, many of those breaks are relegated to obsolete productions, mostly
// because it is common to not properly handle breaks in those locations.
//
// So how do we do line breaking? The algorithm we implement is greedy, to
// simplify implementation. There are two margins: the soft margin, which we
// want to keep within, and the hard margin, which we absolutely have to keep
// within. There are also two kinds of break points: preferred and emergency.
// As long as we keep the line within the hard margin, we will only break at
// preferred breakpoints; emergency breakpoints are only used if we would
// otherwise exceed the hard margin.
//
// For illustration, here is an example header and where these break points are
// located:
//
//            To: John "The Rock" Smith <jsmith@a.long.domain.invalid>
// Preferred:         ^          ^     ^
// Emergency:         ^    ^     ^     ^^      ^ ^    ^      ^       ^
//
// Preferred breakpoints are indicated by setting the mayBreakAfter parameter of
// addText to true, while emergency breakpoints are set after every token passed
// into addText. This is handled implicitly by only adding text to _currentLine
// if it ends in an emergency breakpoint.
//
// Internally, the code keeps track of margins by use of two variables. The
// _softMargin and _hardMargin variables encode the positions at which code must
// absolutely break, and are set up from the initial options parameter. Breaking
// happens when _currentLine.length approaches these values, as mentioned above.

/**
 * Send a header line consisting of the first N characters to the handler.
 *
 * If the count parameter is missing, then we presume that the current header
 * value being emitted is done and therefore we should not send a continuation
 * space. Otherwise, we presume that we're still working, so we will send the
 * continuation space.
 *
 * @private
 * @param [count] {Integer} The number of characters in the current line to
 *   include before wrapping.
 */
HeaderEmitter.prototype._commitLine = function (count) {
  let isContinuing = typeof count !== "undefined";

  // Split at the point, and lop off whitespace immediately before and after.
  if (isContinuing) {
    var firstN = this._currentLine.slice(0, count).trimRight();
    var lastN = this._currentLine.slice(count).trimLeft();
  } else {
    var firstN = this._currentLine.trimRight();
    var lastN = "";
  }

  // How many characters do we need to shift preferred/emergency breakpoints?
  let shift = this._currentLine.length - lastN.length;

  // Send the line plus the final CRLF.
  this._handler.deliverData(firstN + '\r\n');

  // Fill the start of the line with the new data.
  this._currentLine = lastN;

  // If this is a continuation, add an extra space at the beginning of the line.
  // Adjust the breakpoint shift amount as well.
  if (isContinuing) {
    this._currentLine = ' ' + this._currentLine;
    shift++;
  }

  // We will always break at a point at or after the _preferredBreakpoint, if it
  // exists, so this always gets reset to 0.
  this._preferredBreakpoint = 0;
};

/**
 * Reserve at least length characters in the current line. If there aren't
 * enough characters, insert a line break.
 *
 * @private
 * @param length {Integer} The number of characters to reserve space for.
 * @return {Boolean} Whether or not there is enough space for length characters.
 */
HeaderEmitter.prototype._reserveTokenSpace = function (length) {
  // We are not going to do a sanity check that length is within the wrap
  // margins. The rationale is that this lets code simply call this function to
  // force a higher-level line break than normal preferred line breaks (see
  // addAddress for an example use). The text that would be added may need to be
  // itself broken up, so it might not need all the length anyways, but it
  // starts the break already.

  // If we have enough space, we don't need to do anything.
  if (this._currentLine.length + length <= this._softMargin)
    return true;

  // If we have a preferred breakpoint, commit the line at that point, and see
  // if that is sufficient line-breaking.
  if (this._preferredBreakpoint > 0) {
    this._commitLine(this._preferredBreakpoint);
    if (this._currentLine.length + length <= this._softMargin)
      return true;
  }

  // At this point, we can no longer keep within the soft margin. Let us see if
  // we can fit within the hard margin.
  if (this._currentLine.length + length <= this._hardMargin) {
    return true;
  }

  // Adding the text to length would violate the hard margin as well. Break at
  // the last emergency breakpoint.
  if (this._currentLine.length > 0) {
    this._commitLine(this._currentLine.length);
  }

  // At this point, if there is still insufficient room in the hard margin, we
  // can no longer do anything to encode this word. Bail.
  return this._currentLine.length + length <= this._hardMargin;
};

/**
 * Adds a block of text to the current header, inserting a break if necessary.
 * If mayBreakAfter is true and text does not end in whitespace, a single space
 * character may be added to the output. If the text could not be added without
 * violating line length restrictions, an error is thrown instead.
 *
 * @protected
 * @param {String}  text          The text to add to the output.
 * @param {Boolean} mayBreakAfter If true, the end of this text is a preferred
 *                                breakpoint.
 */
HeaderEmitter.prototype.addText = function (text, mayBreakAfter) {
  // Try to reserve space for the tokens. If we can't, give up.
  if (!this._reserveTokenSpace(text.length))
    throw new Error("Cannot encode " + text + " due to length.");

  this._currentLine += text;
  if (mayBreakAfter) {
    // Make sure that there is an extra space if text could break afterwards.
    this._preferredBreakpoint = this._currentLine.length;
    if (text[text.length - 1] != ' ') {
      this._currentLine += ' ';
    }
  }
};

/**
 * Adds a block of text that may need quoting if it contains some character in
 * qchars. If it is already quoted, no quoting will be applied. If the text
 * cannot be added without violating maximum line length, an error is thrown
 * instead.
 *
 * @protected
 * @param {String}  text          The text to add to the output.
 * @param {String}  qchars        The set of characters that cannot appear
 *                                outside of a quoted string.
 * @param {Boolean} mayBreakAfter If true, the end of this text is a preferred
 *                                breakpoint.
 */
HeaderEmitter.prototype.addQuotable = function (text, qchars, mayBreakAfter) {
  // No text -> no need to be quoted (prevents strict warning errors).
  if (text.length == 0)
    return;

  // Figure out if we need to quote the string. Don't quote a string which
  // already appears to be quoted.
  let needsQuote = false;

  if (!(text[0] == '"' && text[text.length - 1] == '"') && qchars != '') {
    for (let i = 0; i < text.length; i++) {
      if (qchars.contains(text[i])) {
        needsQuote = true;
        break;
      }
    }
  }

  if (needsQuote)
    text = '"' + text.replace(/["\\]/g, "\\$&") + '"';
  this.addText(text, mayBreakAfter);
};

/**
 * Adds a block of text that corresponds to the phrase production in RFC 5322.
 * Such text is a sequence of atoms, quoted-strings, or RFC-2047 encoded-words.
 * This method will preprocess input to normalize all space sequences to a
 * single space. If the text cannot be added without violating maximum line
 * length, an error is thrown instead.
 *
 * @protected
 * @param {String}  text          The text to add to the output.
 * @param {String}  qchars        The set of characters that cannot appear
 *                                outside of a quoted string.
 * @param {Boolean} mayBreakAfter If true, the end of this text is a preferred
 *                                breakpoint.
 */
HeaderEmitter.prototype.addPhrase = function (text, qchars, mayBreakAfter) {
  // Collapse all whitespace spans into a single whitespace node.
  text = text.replace(/[ \t\r\n]+/g, " ");

  // If we have non-ASCII text, encode it using RFC 2047.
  if (this._useASCII && nonAsciiRe.test(text)) {
    this.encodeRFC2047Phrase(text, mayBreakAfter);
    return;
  }

  // If quoting the entire string at once could fit in the line length, then do
  // so. The check here is very loose, but this will inform is if we are going
  // to definitely overrun the soft margin.
  if (text.length < this._softMargin) {
    try {
      this.addQuotable(text, qchars, mayBreakAfter);
      // If we don't have a breakpoint, and the text is encoded as a sequence of
      // atoms (and not a quoted-string), then make the last space we added a
      // breakpoint, regardless of the mayBreakAfter setting.
      if (this._preferredBreakpoint == 0 && text.contains(" ")) {
        if (this._currentLine[this._currentLine.length - 1] != '"')
          this._preferredBreakpoint = this._currentLine.lastIndexOf(" ");
      }
      return;
    } catch (e) {
      // If we get an error at this point, we failed to add the quoted string
      // because the string was too long. Fall through to the case where we know
      // that the input was too long to begin with.
    }
  }

  // If the text is too long, split the quotable string at space boundaries and
  // add each word invidually. If we still can't add all those words, there is
  // nothing that we can do.
  let words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    this.addQuotable(words[i], qchars,
      i == words.length - 1 ? mayBreakAfter : true);
  }
};

/// A regular expression for characters that need to be encoded.
let nonAsciiRe = /[^\x20-\x7e]/;

/// The beginnings of RFC 2047 encoded-word
const b64Prelude = "=?UTF-8?B?", qpPrelude = "=?UTF-8?Q?";

/// A list of ASCII characters forbidden in RFC 2047 encoded-words
const qpForbidden = "=?_()\"";

const hexString = "0123456789abcdef";

/**
 * Add a block of text as a single RFC 2047 encoded word. This does not try to
 * split words if they are too long.
 *
 * @private
 * @param {Uint8Array} encodedText   The octets to encode.
 * @param {Boolean}    useQP         If true, use quoted-printable; if false,
 *                                   use base64.
 * @param {Boolean}    mayBreakAfter If true, the end of this text is a
 *                                   preferred breakpoint.
 */
HeaderEmitter.prototype._addRFC2047Word = function (encodedText, useQP,
    mayBreakAfter) {
  let binaryString = mimeutils.typedArrayToString(encodedText);
  if (useQP) {
    var token = qpPrelude;
    for (let i = 0; i < encodedText.length; i++) {
      if (encodedText[i] < 0x20 || encodedText[i] >= 0x7F ||
          qpForbidden.contains(binaryString[i])) {
        let ch = encodedText[i];
        token += "=" + hexString[(ch & 0xf0) >> 4] + hexString[ch & 0x0f];
      } else if (binaryString[i] == " ") {
        token += "_";
      } else {
        token += binaryString[i];
      }
    }
    token += "?=";
  } else {
    var token = b64Prelude + btoa(binaryString) + "?=";
  }
  this.addText(token, mayBreakAfter);
};

/**
 * Add a block of text as potentially several RFC 2047 encoded-word tokens.
 *
 * @protected
 * @param {String}  text          The text to add to the output.
 * @param {Boolean} mayBreakAfter If true, the end of this text is a preferred
 *                                breakpoint.
 */
HeaderEmitter.prototype.encodeRFC2047Phrase = function (text, mayBreakAfter) {
  // Start by encoding the text into UTF-8 directly.
  let encodedText = new TextEncoder("UTF-8").encode(text);

  // Make sure there's enough room for a single token.
  let minLineLen = b64Prelude.length + 10; // Eight base64 characters plus ?=
  if (!this._reserveTokenSpace(minLineLen)) {
    this._commitLine(this._currentLine.length);
  }

  // Try to encode as much UTF-8 text as possible in each go.
  let b64Len = 0, qpLen = 0, start = 0;
  let maxChars = (this._softMargin - this._currentLine.length) -
    (b64Prelude.length + 2);
  for (let i = 0; i < encodedText.length; i++) {
    let b64Inc = 0, qpInc = 0;
    // The length we need for base64 is ceil(length / 3) * 4...
    if ((i - start) % 3 == 0)
      b64Inc += 4;

    // The length for quoted-printable is 3 chars only if encoded
    if (encodedText[i] < 0x20 || encodedText[i] >= 0x7f ||
        qpForbidden.contains(String.fromCharCode(encodedText[i]))) {
      qpInc = 3;
    } else {
      qpInc = 1;
    }

    if (b64Len + b64Inc > maxChars && qpLen + qpInc > maxChars) {
      // Oops, we have too many characters! We need to encode everything through
      // the current character. However, we can't split in the middle of a
      // multibyte character. In UTF-8, characters that start with 10xx xxxx are
      // the middle of multibyte characters, so backtrack until the start
      // character is legal.
      while ((encodedText[i] & 0xC0) == 0x80)
        --i;

      // Add this part of the word and then make a continuation.
      this._addRFC2047Word(encodedText.subarray(start, i), b64Len >= qpLen,
        true);

      // Reset the array for parsing.
      start = i;
      --i; // Reparse this character as well
      b64Len = qpLen = 0;
      maxChars = this._softMargin - b64Prelude.length - 3;
    } else {
      // Add the counts for the current variable to the count to encode.
      b64Len += b64Inc;
      qpLen += qpInc;
    }
  }

  // Add the entire array at this point.
  this._addRFC2047Word(encodedText.subarray(start), b64Len >= qpLen,
    mayBreakAfter);
};

////////////////////////
// High-level methods //
////////////////////////

/**
 * Add the header name, with the colon and trailing space, to the output.
 *
 * @public
 * @param {String} name The name of the header.
 */
HeaderEmitter.prototype.addHeaderName = function (name) {
  this._currentLine = this._currentLine.trimRight();
  if (this._currentLine.length > 0) {
    this._commitLine();
  }
  this.addText(name + ": ", true);
};

/**
 * Add a header and its structured value to the output.
 *
 * The name can be any case-insensitive variant of a known structured header;
 * the output will include the preferred name of the structure instead of the
 * case put into the name. If no structured encoder can be found, and the input
 * value is a string, then the header is assumed to be unstructured and the
 * value is added as if {@link addUnstructured} were called.
 *
 * @public
 * @param {String} name  The name of the header.
 * @param          value The structured value of the header.
 */
HeaderEmitter.prototype.addStructuredHeader = function (name, value) {
  let lowerName = name.toLowerCase();
  if (encoders.has(lowerName)) {
    this.addHeaderName(preferredSpellings.get(lowerName));
    encoders.get(lowerName).call(this, value);
  } else if (typeof value === "string") {
    // Assume it's an unstructured header.
    // All-lower-case-names are ugly, so capitalize first letters.
    name = name.replace(/(^|-)[a-z]/g, function(match) {
      return match.toUpperCase();
    });
    this.addHeaderName(name);
    this.addUnstructured(value);
  } else {
    throw new Error("Unknown header " + name);
  }
};

/**
 * Add a single address to the header. The address is an object consisting of a
 * possibly-empty display name and an email address.
 *
 * @public
 * @param Address addr The address to be added.
 * @param {String} addr.name  The (possibly-empty) name of the address to add.
 * @param {String} addr.email The email of the address to add.
 * @see headerparser.parseAddressingHeader
 */
HeaderEmitter.prototype.addAddress = function (addr) {
  // If we have a display name, add that first.
  if (addr.name) {
    // This is a simple estimate that keeps names on one line if possible.
    this._reserveTokenSpace(addr.name.length + addr.email.length + 3);
    this.addPhrase(addr.name, ",()<>:;.\"", true);

    // If we don't have an email address, don't write out the angle brackets for
    // the address. It's already an abnormal situation should this appear, and
    // this has better round-tripping properties.
    if (!addr.email)
      return;

    this.addText("<", false);
  }

  // Find the local-part and domain of the address, since the local-part may
  // need to be quoted separately. Note that the @ goes to the domain, so that
  // the local-part may be quoted if it needs to be.
  let at = addr.email.lastIndexOf("@");
  let localpart = "", domain = ""
  if (at == -1)
    localpart = addr.email;
  else {
    localpart = addr.email.slice(0, at);
    domain = addr.email.slice(at);
  }

  this.addQuotable(localpart, "()<>[]:;@\\,\" !", false);
  this.addText(domain + (addr.name ? ">" : ""), false);
};

/**
 * Add an array of addresses and groups to the output. Such an array may be
 * found as the output of {@link headerparser.parseAddressingHeader}. Each
 * element is either an address (an object with properties name and email), or a
 * group (an object with properties name and group).
 *
 * @public
 * @param {(Address|Group)[]} addrs A collection of addresses to add.
 * @param {String}    addrs[i].name    The (possibly-empty) name of the
 *                                     address or the group to add.
 * @param {String}    [addrs[i].email] The email of the address to add.
 * @param {Address[]} [addrs[i].group] A list of email addresses in the group.
 * @see HeaderEmitter.addAddress
 * @see headerparser.parseAddressingHeader
 */
HeaderEmitter.prototype.addAddresses = function (addresses) {
  let needsComma = false;
  for (let addr of addresses) {
    // Add a comma if this is not the first element.
    if (needsComma)
      this.addText(", ", true);
    needsComma = true;

    if ("email" in addr) {
      this.addAddress(addr);
    } else {
      // A group has format name: member, member;
      // Note that we still add a comma after the group is completed.
      this.addPhrase(addr.name, ",()<>:;.\"", false);
      this.addText(":", true);

      this.addAddresses(addr.group);
      this.addText(";", true);
    }
  }
};

/**
 * Add an unstructured header value to the output. This effectively means only
 * inserting line breaks were necessary, and using RFC 2047 encoding where
 * necessary.
 *
 * @public
 * @param {String} text The text to add to the output.
 */
HeaderEmitter.prototype.addUnstructured = function (text) {
  if (text.length == 0)
    return;

  // Unstructured text is basically a phrase that can't be quoted. So, if we
  // have nothing in qchars, nothing should be quoted.
  this.addPhrase(text, "", false);
};

/** RFC 822 labels for days of the week. */
const kDaysOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Formatting helper to output numbers between 0-9 as 00-09 instead.
 */
function padTo2Digits(num) {
  return num < 10 ? "0" + num : num.toString();
}

/**
 * Add a date/time field to the output, using the JS date object as the time
 * representation. The value will be output using the timezone offset of the
 * date object, which is usually the timezone of the user (modulo timezone and
 * DST changes).
 *
 * Note that if the date is an invalid date (its internal date parameter is a
 * NaN value), this method throws an error instead of generating an invalid
 * string.
 *
 * @public
 * @param {Date} date The date to be added to the output string.
 */
HeaderEmitter.prototype.addDate = function (date) {
  // Rather than make a header plastered with NaN values, throw an error on
  // specific invalid dates.
  if (isNaN(date.getTime()))
    throw new Error("Cannot encode an invalid date");

  // RFC 5322 says years can't be before 1900. The after 9999 is a bit that
  // derives from the specification saying that years have 4 digits.
  if (date.getFullYear() < 1900 || date.getFullYear() > 9999)
    throw new Error("Date year is out of encodable range");

  // Start by computing the timezone offset for a day. We lack a good format, so
  // the the 0-padding is done by hand. Note that the tzoffset we output is in
  // the form ±hhmm, so we need to separate the offset (in minutes) into an hour
  // and minute pair.
  let tzOffset = date.getTimezoneOffset();
  let tzOffHours = Math.abs(Math.trunc(tzOffset / 60));
  let tzOffMinutes = Math.abs(tzOffset) % 60;
  let tzOffsetStr = (tzOffset > 0 ? "-" : "+") +
    padTo2Digits(tzOffHours) + padTo2Digits(tzOffMinutes);

  // Convert the day-time figure into a single value to avoid unwanted line
  // breaks in the middle.
  let dayTime = [
    kDaysOfWeek[date.getDay()] + ",",
    date.getDate(),
    mimeutils.kMonthNames[date.getMonth()],
    date.getFullYear(),
    padTo2Digits(date.getHours()) + ":" +
      padTo2Digits(date.getMinutes()) + ":" +
      padTo2Digits(date.getSeconds()),
    tzOffsetStr
  ].join(" ");
  this.addText(dayTime, false);
};

/**
 * Signal that the current header has been finished encoding.
 *
 * @public
 * @param {Boolean} deliverEOF If true, signal to the handler that no more text
 *                             will be arriving.
 */
HeaderEmitter.prototype.finish = function (deliverEOF) {
  this._commitLine();
  if (deliverEOF)
    this._handler.deliverEOF();
};

/**
 * Make a streaming header emitter that outputs on the given handler.
 *
 * @param {StreamHandler} handler The handler to consume output
 * @param                 options Options to pass into the HeaderEmitter
 *                                constructor.
 * @returns {HeaderEmitter} A header emitter constructed with the given options.
 */
function makeStreamingEmitter(handler, options) {
  return new HeaderEmitter(handler, options);
}

function StringHandler() {
  this.value = "";
  this.deliverData = function (str) { this.value += str; };
  this.deliverEOF = function () { };
}

/**
 * Given a header name and its structured value, output a string containing its
 * MIME-encoded value. The trailing CRLF for the header is included.
 *
 * @param {String} name    The name of the structured header.
 * @param          value   The value of the structured header.
 * @param          options Options for the HeaderEmitter constructor.
 * @returns {String} A MIME-encoded representation of the structured header.
 * @see HeaderEmitter.addStructuredHeader
 */
function emitStructuredHeader(name, value, options) {
  let handler = new StringHandler();
  let emitter = new HeaderEmitter(handler, options);
  emitter.addStructuredHeader(name, value);
  emitter.finish(true);
  return handler.value;
}

/**
 * Given a map of header names and their structured values, output a string
 * containing all of their headers and their MIME-encoded values.
 *
 * This method is designed to be able to emit header values given the headerData
 * values produced by MIME parsing. Thus, the values of the map are arrays
 * corresponding to header multiplicity.
 *
 * @param {Map(String->Object[])} headerValues A map of header names to arrays
 *                                             of their structured values.
 * @param                         options      Options for the HeaderEmitter
 *                                             constructor.
 * @returns {String} A MIME-encoded representation of the structured header.
 * @see HeaderEmitter.addStructuredHeader
 */
function emitStructuredHeaders(headerValues, options) {
  let handler = new StringHandler();
  let emitter = new HeaderEmitter(handler, options);
  for (let instance of headerValues) {
    instance[1].forEach(function (e) {
      emitter.addStructuredHeader(instance[0], e)
    });
  }
  emitter.finish(true);
  return handler.value;
}

/**
 * Add a custom structured MIME encoder to the set of known encoders. These
 * encoders are used for {@link emitStructuredHeader} and similar functions to
 * encode richer, more structured values instead of relying on string
 * representations everywhere.
 *
 * Structured encoders are functions which take in a single parameter
 * representing their structured value. The this parameter is set to be an
 * instance of {@link HeaderEmitter}, and it is intended that the several public
 * or protected methods on that class are useful for encoding values.
 *
 * There is a large set of structured encoders built-in to the jsmime library
 * already.
 *
 * @param {String}          header  The header name (in its preferred case) for
 *                                  which the encoder will be used.
 * @param {Function(Value)} encoder The structured encoder function.
 */
function addStructuredEncoder(header, encoder) {
  let lowerName = header.toLowerCase();
  encoders.set(lowerName, encoder);
  if (!preferredSpellings.has(lowerName))
    preferredSpellings.set(lowerName, header);
}

return Object.freeze({
  addStructuredEncoder: addStructuredEncoder,
  emitStructuredHeader: emitStructuredHeader,
  emitStructuredHeaders: emitStructuredHeaders,
  makeStreamingEmitter: makeStreamingEmitter
});

});

