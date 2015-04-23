define(function(require) {
/**
 * This file implements the structured decoding of message header fields. It is
 * part of the same system as found in mimemimeutils.js, and occasionally makes
 * references to globals defined in that file or other dependencies thereof. See
 * documentation in that file for more information about external dependencies.
 */

"use strict";
var mimeutils = require('./mimeutils');

/**
 * This is the API that we ultimately return.
 *
 * We define it as a global here, because we need to pass it as a |this|
 * argument to a few functions.
 */
var headerparser = {};

/**
 * Tokenizes a message header into a stream of tokens as a generator.
 *
 * The low-level tokens are meant to be loosely correspond to the tokens as
 * defined in RFC 5322. For reasons of saner error handling, however, the two
 * definitions are not exactly equivalent. The tokens we emit are the following:
 * 1. Special delimiters: Any char in the delimiters string is emitted as a
 *    string by itself. Parsing parameter headers, for example, would use ";="
 *    for the delimiter string.
 * 2. Quoted-strings (if opt.qstring is true): A string which is surrounded by
 *    double quotes. Escapes in the string are omitted when returning.
 * 3. Domain Literals (if opt.dliteral is true): A string which matches the
 *    dliteral construct in RFC 5322. Escapes here are NOT omitted.
 * 4. Comments (if opt.comments is true): Comments are handled specially. In
 *    practice, decoding the comments in To headers appears to be necessary, so
 *    comments are not stripped in the output value. Instead, they are emitted
 *    as if they are a special delimiter. However, all delimiters found within a
 *    comment are returned as if they were a quoted string, so that consumers
 *    ignore delimiters within comments. If ignoring comment text completely is
 *    desired, upon seeing a "(" token, consumers should ignore all tokens until
 *    a matching ")" is found (note that comments can be nested).
 * 5. RFC 2047 encoded-words (if opts.rfc2047 is true): These are strings which
 *    are the decoded contents of RFC 2047's =?UTF-8?Q?blah?=-style words.
 * 6. Atoms: Atoms are defined not in the RFC 5322 sense, but rather as the
 *    longest sequence of characters that is neither whitespace nor any of the
 *    special characters above.
 *
 * The intended interpretation of the stream of output tokens is that they are
 * the portions of text which can be safely wrapped in whitespace with no ill
 * effect. The output tokens are either strings (which represent individual
 * delimiter tokens) or instances of a class that has a customized .toString()
 * for output (for quoted strings, atoms, domain literals, and encoded-words).
 * Checking for a delimiter MUST use the strictly equals operator (===). For
 * example, the proper way to call this method is as follows:
 *
 *    for (let token of getHeaderTokens(rest, ";=", opts)) {
 *      if (token === ';') {
 *        // This represents a literal ';' in the string
 *      } else if (token === '=') {
 *        // This represents a literal '=' in the string
 *      } else {
 *        // If a ";" qstring was parsed, we fall through to here!
 *        token = token.toString();
 *      }
 *    }
 *
 * This method does not properly tokenize 5322 in all corner cases; however,
 * this is equivalent in those corner cases to an older header parsing
 * algorithm, so the algorithm should be correct for all real-world cases. The
 * corner cases are as follows:
 * 1. Quoted-strings and domain literals are parsed even if they are within a
 *    comment block (we effectively treat ctext as containing qstring).
 * 2. WSP need not be between a qstring and an atom (a"b" produces two tokens,
 *    a and b). This is an error case, though.
 *
 * @param {String} value      The header value, post charset conversion but
 *                            before RFC 2047 decoding, to be parsed.
 * @param {String} delimiters A set of delimiters to include as individual
 *                            tokens.
 * @param {Object} opts       A set of options selecting what to parse.
 * @param {Boolean} [opts.qstring]  If true, recognize quoted strings.
 * @param {Boolean} [opts.dliteral] If true, recognize domain literals.
 * @param {Boolean} [opts.comments] If true, recognize comments.
 * @param {Boolean} [opts.rfc2047]  If true, parse and decode RFC 2047
 *                                  encoded-words.
 * @returns {(Token|String)[]} An array of Token objects (which have a toString
 *                             method returning their value) or String objects
 *                             (representing delimiters).
 */
function getHeaderTokens(value, delimiters, opts) {
  // The array of parsed tokens. This method used to be a generator, but it
  // appears that generators are poorly optimized in current engines, so it was
  // converted to not be one.
  let tokenList = [];

  /// Represents a non-delimiter token
  function Token(token) {
    // Unescape all quoted pairs. Any trailing \ is deleted.
    this.token = token.replace(/\\(.?)/g, "$1");
  }
  Token.prototype.toString = function () { return this.token; };

  // The start of the current token (e.g., atoms, strings)
  let tokenStart = undefined;
  // The set of whitespace characters, as defined by RFC 5322
  let wsp = " \t\r\n";
  // If we are a domain literal ([]) or a quoted string ("), this is set to the
  // character to look for at the end.
  let endQuote = undefined;
  // The current depth of comments, since they can be nested. A value 0 means we
  // are not in a comment.
  let commentDepth = 0;

  // Iterate over every character one character at a time.
  let length = value.length;
  for (let i = 0; i < length; i++) {
    let ch = value[i];
    // If we see a \, no matter what context we are in, ignore the next
    // character.
    if (ch == '\\') {
      i++;
      continue;
    }

    // If we are in a qstring or a dliteral, process the character only if it is
    // what we are looking for to end the quote.
    if (endQuote !== undefined) {
      if (ch == endQuote && ch == '"') {
        // Quoted strings don't include their delimiters.
        let text = value.slice(tokenStart + 1, i);

        // If RFC 2047 is enabled, decode the qstring only if the entire string
        // appears to be a 2047 token. Don't unquote just yet (this will better
        // match people who incorrectly treat RFC 2047 decoding as a separate,
        // earlier step).
        if (opts.rfc2047 && text.startsWith("=?") && text.endsWith("?="))
          text = decodeRFC2047Words(text);

        tokenList.push(new Token(text));
        endQuote = undefined;
        tokenStart = undefined;
      } else if (ch == endQuote && ch == ']') {
        // Domain literals include their delimiters.
        tokenList.push(new Token(value.slice(tokenStart, i + 1)));
        endQuote = undefined;
        tokenStart = undefined;
      }
      // Avoid any further processing.
      continue;
    }

    // If we can match the RFC 2047 encoded-word pattern, we need to decode the
    // entire word or set of words.
    if (opts.rfc2047 && ch == '=' && i + 1 < value.length && value[i + 1] == '?') {
      // RFC 2047 tokens separated only by whitespace are conceptually part of
      // the same output token, so we need to decode them all at once.
      let encodedWordsRE = /([ \t\r\n]*=\?[^?]*\?[BbQq]\?[^?]*\?=)+/;
      let result = encodedWordsRE.exec(value.slice(i));
      if (result !== null) {
        // If we were in the middle of a prior token (i.e., something like
        // foobar=?UTF-8?Q?blah?=), yield the previous segment as a token.
        if (tokenStart !== undefined) {
          tokenList.push(new Token(value.slice(tokenStart, i)));
          tokenStart = undefined;
        }

        // Find out how much we need to decode...
        let encWordsLen = result[0].length;
        let string = decodeRFC2047Words(value.slice(i, i + encWordsLen),
          "UTF-8");
        // Don't make a new Token variable, since we do not want to unescape the
        // decoded string.
        tokenList.push({ toString: function() { return string; }});

        // Skip everything we decoded. The -1 is because we don't want to
        // include the starting character.
        i += encWordsLen - 1;
        continue;
      }

      // If we are here, then we failed to match the simple 2047 encoded-word
      // regular expression, despite the fact that it matched the =? at the
      // beginning. Fall through and treat the text as if we aren't trying to
      // decode RFC 2047.
    }

    // If we reach this point, we're not inside of quoted strings, domain
    // literals, or RFC 2047 encoded-words. This means that the characters we
    // parse are potential delimiters (unless we're in comments, where
    // everything starts to go really wonky). Several things could happen,
    // depending on the kind of character we read and whether or not we were in
    // the middle of a token. The three values here tell us what we could need
    // to do at this point:
    // tokenIsEnding: The current character is not able to be accumulated to an
    // atom, so we need to flush the atom if there is one.
    // tokenIsStarting: The current character could begin an atom (or
    // anything that requires us to mark the starting point), so we need to save
    // the location.
    // isSpecial: The current character is a delimiter that needs to be output.
    let tokenIsEnding = false, tokenIsStarting = false, isSpecial = false;
    if (wsp.contains(ch)) {
      // Whitespace ends current tokens, doesn't emit anything.
      tokenIsEnding = true;
    } else if (commentDepth == 0 && delimiters.contains(ch)) {
      // Delimiters end the current token, and need to be output. They do not
      // apply within comments.
      tokenIsEnding = true;
      isSpecial = true;
    } else if (opts.qstring && ch == '"') {
      // Quoted strings end the last token and start a new one.
      tokenIsEnding = true;
      tokenIsStarting = true;
      endQuote = ch;
    } else if (opts.dliteral && ch == '[') {
      // Domain literals end the last token and start a new one.
      tokenIsEnding = true;
      tokenIsStarting = true;
      endQuote = ']';
    } else if (opts.comments && ch == '(') {
      // Comments are nested (oh joy). They also end the prior token, and need
      // to be output if the consumer requests it.
      commentDepth++;
      tokenIsEnding = true;
      isSpecial = true;
    } else if (opts.comments && ch == ')') {
      // Comments are nested (oh joy). They also end the prior token, and need
      // to be output if the consumer requests it.
      if (commentDepth > 0)
        commentDepth--;
      tokenIsEnding = true;
      isSpecial = true;
    } else {
      // Not a delimiter, whitespace, comment, domain literal, or quoted string.
      // Must be part of an atom then!
      tokenIsStarting = true;
    }

    // If our analysis concluded that we closed an open token, and there is an
    // open token, then yield that token.
    if (tokenIsEnding && tokenStart !== undefined) {
      tokenList.push(new Token(value.slice(tokenStart, i)));
      tokenStart = undefined;
    }
    // If we need to output a delimiter, do so.
    if (isSpecial)
      tokenList.push(ch);
    // If our analysis concluded that we could open a token, and no token is
    // opened yet, then start the token.
    if (tokenIsStarting && tokenStart === undefined) {
      tokenStart = i;
    }
  }

  // That concludes the loop! If there is a currently open token, close that
  // token now.
  if (tokenStart !== undefined) {
    // Error case: a partially-open quoted string is assumed to have a trailing
    // " character.
    if (endQuote == '"')
      tokenList.push(new Token(value.slice(tokenStart + 1)));
    else
      tokenList.push(new Token(value.slice(tokenStart)));
  }

  return tokenList;
}

/**
 * Convert a header value into UTF-16 strings by attempting to decode as UTF-8
 * or another legacy charset. If the header is valid UTF-8, it will be decoded
 * as UTF-8; if it is not, the fallbackCharset will be attempted instead.
 *
 * @param {String} headerValue       The header (as a binary string) to attempt
 *                                   to convert to UTF-16.
 * @param {String} [fallbackCharset] The optional charset to try if UTF-8
 *                                   doesn't work.
 * @returns {String} The UTF-16 representation of the string above.
 */
function convert8BitHeader(headerValue, fallbackCharset) {
  // Only attempt to convert the headerValue if it contains non-ASCII
  // characters.
  if (/[\x80-\xff]/.exec(headerValue)) {
    // First convert the value to a typed-array for TextDecoder.
    let typedarray = mimeutils.stringToTypedArray(headerValue);

    // Don't try UTF-8 as fallback (redundant), and don't try UTF-16 or UTF-32
    // either, since they radically change header interpretation.
    // If we have a fallback charset, we want to know if decoding will fail;
    // otherwise, we want to replace with substitution chars.
    let hasFallback = fallbackCharset &&
                      !fallbackCharset.toLowerCase().startsWith("utf");
    let utf8Decoder = new TextDecoder("utf-8", {fatal: hasFallback});
    try {
      headerValue = utf8Decoder.decode(typedarray);
    } catch (e) {
      // Failed, try the fallback
      let decoder = new TextDecoder(fallbackCharset, {fatal: false});
      headerValue = decoder.decode(typedarray);
    }
  }
  return headerValue;
}

/**
 * Decodes all RFC 2047 encoded-words in the input string. The string does not
 * necessarily have to contain any such words. This is useful, for example, for
 * parsing unstructured headers.
 *
 * @param {String} headerValue The header which may contain RFC 2047 encoded-
 *                             words.
 * @returns {String} A full UTF-16 string with all encoded words expanded.
 */
function decodeRFC2047Words(headerValue) {
  // Unfortunately, many implementations of RFC 2047 encoding are actually wrong
  // in that they split over-long encoded words without regard for whether or
  // not the split point is in the middle of a multibyte character. Therefore,
  // we need to be able to handle these situations gracefully. This is done by
  // using the decoder in streaming mode so long as the next token is another
  // 2047 token with the same charset.
  let lastCharset = '', currentDecoder = undefined;

  /**
   * Decode a single RFC 2047 token. This function is inline so that we can
   * easily close over the lastCharset/currentDecoder variables, needed for
   * handling bad RFC 2047 productions properly.
   */
  function decode2047Token(token) {
    let tokenParts = token.split("?");

    // If it's obviously not a valid token, return false immediately.
    if (tokenParts.length != 5 || tokenParts[4] != '=')
      return false;

    // The charset parameter is defined in RFC 2231 to be charset or
    // charset*language. We only care about the charset here, so ignore any
    // language parameter that gets passed in.
    let charset = tokenParts[1].split('*', 1)[0];
    let encoding = tokenParts[2], text = tokenParts[3];

    let buffer;
    if (encoding == 'B' || encoding == 'b') {
      // Decode base64. If there's any non-base64 data, treat the string as
      // an illegal token.
      if (/[^A-Za-z0-9+\/=]/.exec(text))
        return false;

      // Base64 strings must be a length of multiple 4, but it seems that some
      // mailers accidentally insert one too many `=' chars. Gracefully handle
      // this case; see bug 227290 for more information.
      if (text.length % 4 == 1 && text.charAt(text.length - 1) == '=')
        text = text.slice(0, -1);

      // Decode the string
      buffer = mimeutils.decode_base64(text, false)[0];
    } else if (encoding == 'Q' || encoding == 'q') {
      // Q encoding here looks a lot like quoted-printable text. The differences
      // between quoted-printable and this are that quoted-printable allows you
      // to quote newlines (this doesn't), while this replaces spaces with _.
      // We can reuse the decode_qp code here, since newlines are already
      // stripped from the header. There is one edge case that could trigger a
      // false positive, namely when you have a single = or an = followed by
      // whitespace at the end of the string. Such an input string is already
      // malformed to begin with, so stripping the = and following input in that
      // case should not be an important loss.
      buffer = mimeutils.decode_qp(text.replace(/_/g, ' '), false)[0];
    } else {
      return false;
    }

    // Make the buffer be a typed array for what follows
    buffer = mimeutils.stringToTypedArray(buffer);

    // If we cannot reuse the last decoder, flush out whatever remains.
    var output = '';
    if (charset != lastCharset && currentDecoder) {
      output += currentDecoder.decode();
      currentDecoder = null;
    }

    // Initialize the decoder for this token.
    lastCharset = charset;
    if (!currentDecoder) {
      try {
        currentDecoder = new TextDecoder(charset, {fatal: false});
      } catch (e) {
        // We don't recognize the charset, so give up.
        return false;
      }
    }

    // Convert this token with the buffer. Note the stream parameter--although
    // RFC 2047 tokens aren't supposed to break in the middle of a multibyte
    // character, a lot of software messes up and does so because it's hard not
    // to (see headeremitter.js for exactly how hard!).
    return output + currentDecoder.decode(buffer, {stream: true});
  }

  // The first step of decoding is to split the string into RFC 2047 and
  // non-RFC 2047 tokens. RFC 2047 tokens look like the following:
  // =?charset?c?text?=, where c is one of B, b, Q, and q. The split regex does
  // some amount of semantic checking, so that malformed RFC 2047 tokens will
  // get ignored earlier.
  let components = headerValue.split(/(=\?[^?]*\?[BQbq]\?[^?]*\?=)/);
  for (let i = 0; i < components.length; i++) {
    if (components[i].substring(0, 2) == "=?") {
      let decoded = decode2047Token(components[i]);
      if (decoded !== false) {
        // If 2047 decoding succeeded for this bit, rewrite the original value
        // with the proper decoding.
        components[i] = decoded;

        // We're done processing, so continue to the next link.
        continue;
      }
    } else if (/^[ \t\r\n]*$/.exec(components[i])) {
      // Whitespace-only tokens get squashed into nothing, so 2047 tokens will
      // be concatenated together.
      components[i] = '';
      continue;
    }

    // If there was stuff left over from decoding the last 2047 token, flush it
    // out.
    lastCharset = '';
    if (currentDecoder) {
      components[i] = currentDecoder.decode() + components[i];
      currentDecoder = null;
    }
  }

  // After the for loop, we'll have a set of decoded strings. Concatenate them
  // together to make the return value.
  return components.join('');
}

///////////////////////////////
// Structured field decoders //
///////////////////////////////

/**
 * Extract a list of addresses from a header which matches the RFC 5322
 * address-list production, possibly doing RFC 2047 decoding along the way.
 *
 * The output of this method is an array of elements corresponding to the
 * addresses and the groups in the input header. An address is represented by
 * an object of the form:
 * {
 *   name: The display name of the address
 *   email: The address of the object
 * }
 * while a group is represented by an object of the form:
 * {
 *   name: The display name of the group
 *   group: An array of address object for members in the group.
 * }
 *
 * @param {String} header     The MIME header text to be parsed
 * @param {Boolean} doRFC2047 If true, decode RFC 2047 parameters found in the
 *                            header.
 * @returns {(Address|Group)[]} An array of the addresses found in the header,
 *                              where each element is of the form mentioned
 *                              above.
 */
function parseAddressingHeader(header, doRFC2047) {
  // Default to true
  if (doRFC2047 === undefined)
    doRFC2047 = true;

  // The final (top-level) results list to append to.
  let results = [];
  // Temporary results
  let addrlist = [];

  // Build up all of the values
  var name = '', groupName = '', address = '';
  // Indicators of current state
  var inAngle = false, needsSpace = false;
  // Main parsing loop
  for (let token of getHeaderTokens(header, ":,;<>@",
        {qstring: true, comments: true, dliteral: true, rfc2047: doRFC2047})) {
    if (token === ':') {
      groupName = name;
      name = '';
      // If we had prior email address results, commit them to the top-level.
      if (addrlist.length > 0)
        results = results.concat(addrlist);
      addrlist = [];
    } else if (token === '<') {
      inAngle = true;
    } else if (token === '>') {
      inAngle = false;
    } else if (token === '@') {
      // An @ means we see an email address. If we're not within <> brackets,
      // then we just parsed an email address instead of a display name. Empty
      // out the display name for the current production.
      if (!inAngle) {
        address = name;
        name = '';
      }
      // Keep the local-part quoted if it needs to be.
      if (/[ !()<>\[\]:;@\\,"]/.exec(address) !== null)
        address = '"' + address.replace(/([\\"])/g, "\\$1") + '"';
      address += '@';
    } else if (token === ',') {
      // A comma ends the current name. If we have something that's kind of a
      // name, add it to the result list. If we don't, then our input looks like
      // To: , , -> don't bother adding an empty entry.
      if (name !== '' || address !== '')
        addrlist.push({
          name: name,
          email: address
        });
      name = address = '';
    } else if (token === ';') {
      // Add pending name to the list
      if (name !== '' || address !== '')
        addrlist.push({name: name, email: address});

      // If no group name was found, treat the ';' as a ','. In any case, we
      // need to copy the results of addrlist into either a new group object or
      // the main list.
      if (groupName === '') {
        results = results.concat(addrlist);
      } else {
        results.push({
          name: groupName,
          group: addrlist
        });
      }
      // ... and reset every other variable.
      addrlist = [];
      groupName = name = address = '';
    } else {
      // This is either the comment delimiters, a quoted-string, or some span of
      // dots and atoms.

      // Ignore the needs space if we're a "close" delimiter token.
      if (needsSpace && token !== ')' && token.toString()[0] != '.')
        token = ' ' + token;

      // Which field do we add this data to?
      if (inAngle || address !== '')
        address += token;
      else
        name += token;

      // We need space for the next token if we aren't some kind of comment or
      // . delimiter.
      needsSpace = token !== '(' && token !== ' (' && token.toString()[0] != '.';
      // The fall-through case after this resets needsSpace to false, and we
      // don't want that!
      continue;
    }

    // If we just parsed a delimiter, we don't need any space for the next
    // token.
    needsSpace = false;
  }

  // If we're missing the final ';' of a group, assume it was present. Also, add
  // in the details of any email/address that we previously saw.
  if (name !== '' || address !== '')
    addrlist.push({name: name, email: address});
  if (groupName !== '') {
    results.push({name: groupName, group: addrlist});
    addrlist = [];
  }

  // Add the current address list build-up to the list of addresses, and return
  // the whole array to the caller.
  return results.concat(addrlist);
}

/**
 * Extract parameters from a header which is a series of ;-separated
 * attribute=value tokens.
 *
 * @param {String} headerValue The MIME header value to parse.
 * @param {Boolean} doRFC2047  If true, decode RFC 2047 encoded-words.
 * @param {Boolean} doRFC2231  If true, decode RFC 2231 encoded parameters.
 * @return {Map(String -> String)} A map of parameter names to parameter values.
 *                                 The property preSemi is set to the token that
 *                                 precedes the first semicolon.
 */
function parseParameterHeader(headerValue, doRFC2047, doRFC2231) {
  // The basic syntax of headerValue is token [; token = token-or-qstring]*
  // Copying more or less liberally from nsMIMEHeaderParamImpl:
  // The first token is the text to the first whitespace or semicolon.
  var semi = headerValue.indexOf(";");
  if (semi < 0) {
    var start = headerValue;
    var rest = '';
  } else {
    var start = headerValue.substring(0, semi);
    var rest = headerValue.substring(semi); // Include the semicolon
  }
  // Strip start to be <WSP><nowsp><WSP>.
  start = start.trim().split(/[ \t\r\n]/)[0];

  // Decode the the parameter tokens.
  let opts = {qstring: true, rfc2047: doRFC2047};
  // Name is the name of the parameter, inName is true iff we don't have a name
  // yet.
  let name = '', inName = true;
  // Matches is a list of [name, value] pairs, where we found something that
  // looks like name=value in the input string.
  let matches = [];
  for (let token of getHeaderTokens(rest, ";=", opts)) {
    if (token === ';') {
      // If we didn't find a name yet (we have ... tokenA; tokenB), push the
      // name with an empty token instead.
      if (name != '' && inName == false)
        matches.push([name, '']);
      name = '';
      inName = true;
    } else if (token === '=') {
      inName = false;
    } else if (inName && name == '') {
      name = token.toString();
    } else if (!inName && name != '') {
      token = token.toString();
      // RFC 2231 doesn't make it clear if %-encoding is supposed to happen
      // within a quoted string, but this is very much required in practice. If
      // it ends with a '*', then the string is an extended-value, which means
      // that its value may be %-encoded.
      if (doRFC2231 && name.endsWith('*')) {
        token = token.replace(/%([0-9A-Fa-f]{2})/g,
          function percent_deencode(match, hexchars) {
            return String.fromCharCode(parseInt(hexchars, 16));
        });
      }
      matches.push([name, token]);
      // Clear the name, so we ignore anything afterwards.
      name = '';
    } else if (inName) {
      // We have ...; tokenA tokenB ... -> ignore both tokens
      name = ''; // Error recovery, ignore this one
    }
  }
  // If we have a leftover ...; tokenA, push the tokenA
  if (name != '' && inName == false)
    matches.push([name, '']);

  // Now matches holds the parameters, so clean up for RFC 2231. There are three
  // cases: param=val, param*=us-ascii'en-US'blah, and param*n= variants. The
  // order of preference is to pick the middle, then the last, then the first.
  // Note that we already unpacked %-encoded values.

  // simpleValues is just a straight parameter -> value map.
  // charsetValues is the parameter -> value map, although values are stored
  // before charset decoding happens.
  // continuationValues maps parameter -> array of values, with extra properties
  // valid (if we decided we couldn't do anything anymore) and hasCharset (which
  // records if we need to decode the charset parameter or not).
  var simpleValues = new Map(), charsetValues = new Map(),
      continuationValues = new Map();
  for (let pair of matches) {
    let name = pair[0];
    let value = pair[1];
    // Get first index, not last index, so we match param*0*= like param*0=.
    let star = name.indexOf('*');
    if (star == -1) {
      // This is the case of param=val. Select the first value here, if there
      // are multiple ones.
      if (!simpleValues.has(name))
        simpleValues.set(name, value);
    } else if (star == name.length - 1) {
      // This is the case of param*=us-ascii'en-US'blah.
      name = name.substring(0, star);
      // Again, select only the first value here.
      if (!charsetValues.has(name))
        charsetValues.set(name, value);
    } else {
      // This is the case of param*0= or param*0*=.
      let param = name.substring(0, star);
      let entry = continuationValues.get(param);
      // Did we previously find this one to be bungled? Then ignore it.
      if (continuationValues.has(param) && !entry.valid)
        continue;

      // If we haven't seen it yet, set up entry already. Note that entries are
      // not straight string values but rather [valid, hasCharset, param0, ... ]
      if (!continuationValues.has(param)) {
        entry = new Array();
        entry.valid = true;
        entry.hasCharset = undefined;
        continuationValues.set(param, entry);
      }

      // When the string ends in *, we need to charset decoding.
      // Note that the star is only meaningful for the *0*= case.
      let lastStar = name[name.length - 1] == '*';
      let number = name.substring(star + 1, name.length - (lastStar ? 1 : 0));
      if (number == '0')
        entry.hasCharset = lastStar;

      // Is the continuation number illegal?
      else if ((number[0] == '0' && number != '0') ||
          !(/^[0-9]+$/.test(number))) {
        entry.valid = false;
        continue;
      }
      // Normalize to an integer
      number = parseInt(number, 10);

      // Is this a repeat? If so, bail.
      if (entry[number] !== undefined) {
        entry.valid = false;
        continue;
      }

      // Set the value for this continuation index. JS's magic array setter will
      // expand the array if necessary.
      entry[number] = value;
    }
  }

  // Build the actual parameter array from the parsed values
  var values = new Map();
  // Simple values have lowest priority, so just add everything into the result
  // now.
  for (let pair of simpleValues) {
    values.set(pair[0], pair[1]);
  }

  if (doRFC2231) {
    // Continuation values come next
    for (let pair of continuationValues) {
      let name = pair[0];
      let entry = pair[1];
      // If we never saw a param*0= or param*0*= value, then we can't do any
      // reasoning about what it looks like, so bail out now.
      if (entry.hasCharset === undefined) continue;

      // Use as many entries in the array as are valid--if we are missing an
      // entry, stop there.
      let valid = true;
      for (var i = 0; valid && i < entry.length; i++)
        if (entry[i] === undefined)
          valid = false;

      // Concatenate as many parameters as are valid. If we need to decode thec
      // charset, do so now.
      var value = entry.slice(0, i).join('');
      if (entry.hasCharset) {
        try {
          value = decode2231Value(value);
        } catch (e) {
          // Bad charset, don't add anything.
          continue;
        }
      }
      // Finally, add this to the output array.
      values.set(name, value);
    }

    // Highest priority is the charset conversion.
    for (let pair of charsetValues) {
      try {
        values.set(pair[0], decode2231Value(pair[1]));
      } catch (e) {
        // Bad charset, don't add anything.
      }
    }
  }

  // Finally, return the values computed above.
  values.preSemi = start;
  return values;
}

/**
 * Convert a RFC 2231-encoded string parameter into a Unicode version of the
 * string. This assumes that percent-decoding has already been applied.
 *
 * @param {String} value The RFC 2231-encoded string to decode.
 * @return The Unicode version of the string.
 */
function decode2231Value(value) {
  let quote1 = value.indexOf("'");
  let quote2 = quote1 >= 0 ? value.indexOf("'", quote1 + 1) : -1;

  let charset = (quote1 >= 0 ? value.substring(0, quote1) : "");
  // It turns out that the language isn't useful anywhere in our codebase for
  // the present time, so we will safely ignore it.
  //var language = (quote2 >= 0 ? value.substring(quote1 + 2, quote2) : "");
  value = value.substring(Math.max(quote1, quote2) + 1);

  // Convert the value into a typed array for decoding
  let typedarray = mimeutils.stringToTypedArray(value);

  // Decode the charset. If the charset isn't found, we throw an error. Try to
  // fallback in that case.
  return new TextDecoder(charset, {fatal: true})
    .decode(typedarray, {stream: false});
}

// This is a map of known timezone abbreviations, for fallback in obsolete Date
// productions.
const kKnownTZs = {
  // The following timezones are explicitly listed in RFC 5322.
  "UT":  "+0000", "GMT": "+0000",
  "EST": "-0500", "EDT": "-0400",
  "CST": "-0600", "CDT": "-0500",
  "MST": "-0700", "MDT": "-0600",
  "PST": "-0800", "PDT": "-0700",
  // The following are time zones copied from NSPR's prtime.c
  "AST": "-0400", // Atlantic Standard Time
  "NST": "-0330", // Newfoundland Standard Time
  "BST": "+0100", // British Summer Time
  "MET": "+0100", // Middle Europe Time
  "EET": "+0200", // Eastern Europe Time
  "JST": "+0900"  // Japan Standard Time
};

/**
 * Parse a header that contains a date-time definition according to RFC 5322.
 * The result is a JS date object with the same timestamp as the header.
 *
 * The dates returned by this parser cannot be reliably converted back into the
 * original header for two reasons. First, JS date objects cannot retain the
 * timezone information they were initialized with, so reserializing a date
 * header would necessarily produce a date in either the current timezone or in
 * UTC. Second, JS dates measure time as seconds elapsed from the POSIX epoch
 * excluding leap seconds. Any timestamp containing a leap second is instead
 * converted into one that represents the next second.
 *
 * Dates that do not match the RFC 5322 production are instead attempted to
 * parse using the Date.parse function. The strings that are accepted by
 * Date.parse are not fully defined by the standard, but most implementations
 * should accept strings that look rather close to RFC 5322 strings. Truly
 * invalid dates produce a formulation that results in an invalid date,
 * detectable by having its .getTime() method return NaN.
 *
 * @param {String} header The MIME header value to parse.
 * @returns {Date}        The date contained within the header, as described
 *                        above.
 */
function parseDateHeader(header) {
  let tokens = [for (x of getHeaderTokens(header, ",:", {})) x.toString()];
  // What does a Date header look like? In practice, most date headers devolve
  // into Date: [dow ,] dom mon year hh:mm:ss tzoff [(abbrev)], with the day of
  // week mostly present and the timezone abbreviation mostly absent.

  // First, ignore the day-of-the-week if present. This would be the first two
  // tokens.
  if (tokens.length > 1 && tokens[1] === ',')
    tokens = tokens.slice(2);

  // If there are too few tokens, the date is obviously invalid.
  if (tokens.length < 8)
    return new Date(NaN);

  // Save off the numeric tokens
  let day = parseInt(tokens[0]);
  // month is tokens[1]
  let year = parseInt(tokens[2]);
  let hours = parseInt(tokens[3]);
  // tokens[4] === ':'
  let minutes = parseInt(tokens[5]);
  // tokens[6] === ':'
  let seconds = parseInt(tokens[7]);

  // Compute the month. Check only the first three digits for equality; this
  // allows us to accept, e.g., "January" in lieu of "Jan."
  let month = mimeutils.kMonthNames.indexOf(tokens[1].slice(0, 3));
  // If the month name is not recognized, make the result illegal.
  if (month < 0)
    month = NaN;

  // Compute the full year if it's only 2 digits. RFC 5322 states that the
  // cutoff is 50 instead of 70.
  if (year < 100) {
    year += year < 50 ? 2000 : 1900;
  }

  // Compute the timezone offset. If it's not in the form ±hhmm, convert it to
  // that form.
  let tzoffset = tokens[8];
  if (tzoffset in kKnownTZs)
    tzoffset = kKnownTZs[tzoffset];
  let decompose = /^([+-])(\d\d)(\d\d)$/.exec(tzoffset);
  // Unknown? Make it +0000
  if (decompose === null)
    decompose = ['+0000', '+', '00', '00'];
  let tzOffsetInMin = parseInt(decompose[2]) * 60 + parseInt(decompose[3]);
  if (decompose[1] == '-')
    tzOffsetInMin = -tzOffsetInMin;

  // How do we make the date at this point? Well, the JS date's constructor
  // builds the time in terms of the local timezone. To account for the offset
  // properly, we need to build in UTC.
  let finalDate = new Date(Date.UTC(year, month, day, hours, minutes, seconds)
    - tzOffsetInMin * 60 * 1000);

  // Suppose our header was mangled and we couldn't read it--some of the fields
  // became undefined. In that case, the date would become invalid, and the
  // indication that it is so is that the underlying number is a NaN. In that
  // scenario, we could build attempt to use JS Date parsing as a last-ditch
  // attempt. But it's not clear that such messages really exist in practice,
  // and the valid formats for Date in ES6 are unspecified.
  return finalDate;
}

////////////////////////////////////////
// Structured header decoding support //
////////////////////////////////////////

// Load the default structured decoders
var structuredDecoders = new Map();
var structuredHeaders = require('./structuredHeaders');
var preferredSpellings = structuredHeaders.spellings;
var forbiddenHeaders = new Set();
for (let pair of structuredHeaders.decoders) {
  addStructuredDecoder(pair[0], pair[1]);
  forbiddenHeaders.add(pair[0].toLowerCase());
}

/**
 * Use an already-registered structured decoder to parse the value of the header
 * into a structured representation.
 *
 * As this method is designed to be used for the internal MIME Parser to convert
 * the raw header values to well-structured values, value is intended to be an
 * array consisting of all occurences of the header in order. However, for ease
 * of use by other callers, it can also be treated as a string.
 *
 * If the decoder for the header is not found, an exception will be thrown.
 *
 * A large set of headers have pre-defined structured decoders; these decoders
 * cannot be overrided with addStructuredDecoder, as doing so could prevent the
 * MIME or message parsers from working properly. The pre-defined structured
 * headers break down into five clases of results, plus some ad-hoc
 * representations. They are:
 *
 * Addressing headers (results are the same as parseAddressingHeader):
 * - Approved
 * - Bcc
 * - Cc
 * - Delivered-To
 * - Disposition-Notification-To
 * - From
 * - Mail-Reply-To
 * - Mail-Followup-To
 * - Reply-To
 * - Resent-Bcc
 * - Resent-Cc
 * - Resent-From
 * - Resent-Reply-To
 * - Resent-Sender
 * - Resent-To
 * - Return-Receipt-To
 * - Sender
 * - To
 *
 * Date headers (results are the same as parseDateHeader):
 * - Date
 * - Expires
 * - Injection-Date
 * - NNTP-Posting-Date
 * - Resent-Date
 *
 * References headers (results are the same as parseReferencesHeader):
 * - (TODO: Parsing support for these headers is currently unsupported)
 *
 * Message-ID headers (results are the first entry of the result of
 * parseReferencesHeader):
 * - (TODO: Parsing support for these headers is currently unsupported)
 *
 * Unstructured headers (results are merely decoded according to RFC 2047):
 * - Comments
 * - Content-Description
 * - Keywords
 * - Subject
 *
 * The ad-hoc headers and their resulting formats are as follows:
 * Content-Type: returns a JS Map of parameter names (in lower case) to their
 * values, along with the following extra properties defined on the map:
 * - mediatype: the type to the left of '/' (e.g., 'text', 'message')
 * - subtype: the type to the right of '/' (e.g., 'plain', 'rfc822')
 * - type: the full typename (e.g., 'text/plain')
 * RFC 2047 and RFC 2231 decoding is applied where appropriate. The values of
 * the type, mediatype, and subtype attributes are all normalized to lower-case,
 * as are the names of all parameters.
 *
 * Content-Transfer-Encoding: the first value is converted to lower-case.
 *
 * @param {String}       header The name of the header of the values.
 * @param {String|Array} value  The value(s) of the headers, after charset
 *                              conversion (if any) has been applied. If it is
 *                              an array, the headers are listed in the order
 *                              they appear in the message.
 * @returns {Object} A structured representation of the header values.
 */
function parseStructuredHeader(header, value) {
  // Enforce that the parameter is an array. If it's a string, make it a
  // 1-element array.
  if (typeof value === "string" || value instanceof String)
    value = [value];
  if (!Array.isArray(value))
    throw new TypeError("Header value is not an array: " + value);

  // Lookup the header in our decoders; if present, use that to decode the
  // header.
  let lowerHeader = header.toLowerCase();
  if (structuredDecoders.has(lowerHeader)) {
    return structuredDecoders.get(lowerHeader).call(headerparser, value);
  }

  // If not present, throw an exception.
  throw new Error("Unknown structured header: " + header);
}

/**
 * Add a custom structured MIME decoder to the set of known decoders. These
 * decoders are used for {@link parseStructuredHeader} and similar functions to
 * encode richer, more structured values instead of relying on string
 * representations everywhere.
 *
 * Structured decoders are functions which take in a single parameter consisting
 * of an array of the string values of the header, in order that they appear in
 * the message. These headers have had the charset conversion (if necessary)
 * applied to them already. The this parameter of the function is set to be the
 * jsmime.headerparser module.
 *
 * There is a large set of structured decoders built-in to the jsmime library
 * already. As these headers are fundamental to the workings of jsmime,
 * attempting to replace them with a custom version will instead produce an
 * exception.
 *
 * @param {String}                       header  The header name (in any case)
 *                                               for which the decoder will be
 *                                               used.
 * @param {Function(String[] -> Object)} decoder The structured decoder
 *                                               function.
 */
function addStructuredDecoder(header, decoder) {
  let lowerHeader = header.toLowerCase();
  if (forbiddenHeaders.has(lowerHeader))
    throw new Error("Cannot override header: " + header);
  structuredDecoders.set(lowerHeader, decoder);
  if (!preferredSpellings.has(lowerHeader))
    preferredSpellings.set(lowerHeader, header);
}

headerparser.addStructuredDecoder = addStructuredDecoder;
headerparser.convert8BitHeader = convert8BitHeader;
headerparser.decodeRFC2047Words = decodeRFC2047Words;
headerparser.getHeaderTokens = getHeaderTokens;
headerparser.parseAddressingHeader = parseAddressingHeader;
headerparser.parseDateHeader = parseDateHeader;
headerparser.parseParameterHeader = parseParameterHeader;
headerparser.parseStructuredHeader = parseStructuredHeader;
return Object.freeze(headerparser);

});

