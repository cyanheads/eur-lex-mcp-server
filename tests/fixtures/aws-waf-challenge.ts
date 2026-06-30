/**
 * @fileoverview Verbatim AWS WAF bot-challenge stub captured from the legacy
 * eur-lex.europa.eu legal-content endpoint (issue #16) — the ~2KB interstitial the
 * WAF now serves in place of the act text. Committed as a constant so the content-
 * service detection test runs fully offline. This is the stub, NOT real act content.
 * @module tests/fixtures/aws-waf-challenge
 */

/** The exact AWS WAF challenge HTML the bug surfaced as `content` (issue #16). */
export const AWS_WAF_CHALLENGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title></title>
    <style>
        body {
            font-family: "Arial";
        }
    </style>
    <script type="text/javascript">
    window.awsWafCookieDomainList = [];
    window.gokuProps = {
"key":"AQIDAHjcYu/GjX+QlghicBgQ/7bFaQZ+m5FKCMDnO+vTbNg96AHX18FNdzKGIbsVtJhN8D4GAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMJ0vjh1Bk+Wfb6p/KAgEQgDv9wPLkAX+9jKuOXiJtH81iNF6FtLPszoEQyT75Ab/ZJGTXamtsyvw79Tcj9GHwsR/maP37k7AM1CObgw==",
          "iv":"D57n4QHFxAAAADAj",
          "context":"RO3ZJjw6FMa9nUQqu0DLIEMXnnpvvgCabQ9dqqnLWOsLydcMU9oR6CNWUesD8Y4MHAy4dBjaA/B7yZDIQsJKSZ3LJA3Mce0kGXMe6WvH/sAjE2DX59wNR+NPyGA3ERNzkrcmtvMgpCd8aC4gzb7Pp7uUn4Uuu3ut72pUcWcqQ79SavngsDY+tFN3+ccEfnX4uqPEpF343yyfWP0rGWvvgXGruqScYs/gHa9ajQiIFW5Up674y/9MJMRKk9KzEhnYebSHGXZ2qeWPobBiq0pJf+DzvPGUrSMS0JdrbyawnR2EnzNqpykSXFDZZK2QX5/2N2J6sMklBozeEGTjZRta7XNJdPPuDvT+VaoboCQaVBebvYjHXt0Z/CY42ZdhFZAgUQn3njQ86wWWmZRVqKk2bOXtT0MF04nJug=="
};
    </script>
    <script src="https://3e3378af7cd0.96689bd6.us-west-2.token.awswaf.com/3e3378af7cd0/b8f8ae018166/c9ffa032f402/challenge.js"></script>
</head>
<body>
    <div id="challenge-container"></div>
    <script type="text/javascript">
        AwsWafIntegration.saveReferrer();
        AwsWafIntegration.checkForceRefresh().then((forceRefresh) => {
            if (forceRefresh) {
                AwsWafIntegration.forceRefreshToken().then(() => {
                    window.location.reload(true);
                });
            } else {
                AwsWafIntegration.getToken().then(() => {
                    window.location.reload(true);
                });
            }
        });
    </script>
    <noscript>
        <h1>JavaScript is disabled</h1>
        In order to continue, we need to verify that you're not a robot.
        This requires JavaScript. Enable JavaScript and then reload the page.
    </noscript>
</body>
</html>`;
