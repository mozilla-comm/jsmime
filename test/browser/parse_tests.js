// The test data is located in xpcshell.ini.
function loadTestData(callback) {
  var xhrreq = new XMLHttpRequest();
  xhrreq.onreadystatechange = function () {
    if (xhrreq.readyState == 4) {
      var lines = xhrreq.responseText.split("\n").filter(function (line) {
        return line[0] == '[' && line != "[DEFAULT]";
      }).map(function (line) {
        return line.slice(1, -1);
      });
      callback(lines);
    }
  };
  xhrreq.open("GET", "../../xpcshell.ini", true);
  xhrreq.overrideMimeType("text/plain");
  xhrreq.send();
}
