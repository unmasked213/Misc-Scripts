// ==UserScript==
// @name         Reddit to Libreddit Redirector
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      3.1
// @description  Automatically redirects Reddit URLs to working Libreddit instances with smart fallback
// @author       Unmasked213
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @match        https://old.reddit.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/reddit_to_libreddit_redirector.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/reddit_to_libreddit_redirector.user.js
// ==/UserScript==


(function() {
    'use strict';

    // Redirect immediately to prevent Reddit from loading
    redirectToLibreddit();

    function redirectToLibreddit() {
        // Get the current URL
        const currentURL = window.location.href;

        // Define a comprehensive list of Libreddit instances
        const libredditInstances = [
            'https://libreddit.kavin.rocks',
            'https://libreddit.spike.codes',
            'https://libreddit.eu',
            'https://libreddit.projectsegfau.lt',
            'https://lr.vern.cc',
            'https://libreddit.northboot.xyz',
            'https://reddit.invak.id',
            'https://snoo.habedieeh.re',
            'https://libreddit.de',
            'https://libreddit.bus-hit.me',
            'https://libreddit.totaldarkness.net',
            'https://libreddit.privacy.com.de',
            'https://libreddit.domain.glass',
            'https://l.opnxng.com',
        ];

        // Extract path from Reddit URL
        const path = currentURL.replace(/^https?:\/\/(www\.|old\.)?reddit\.com/, '');

        // Get working instances from localStorage with timestamp check
        const lastCheck = localStorage.getItem('libreddit_last_check');
        const now = Date.now();
        const workingInstances = JSON.parse(localStorage.getItem('libreddit_working_instances') || '[]');

        // If we have valid cached working instances, use them, otherwise use the full list
        const candidateInstances =
            (lastCheck && (now - parseInt(lastCheck) < 3600000) && workingInstances.length > 0)
            ? workingInstances
            : libredditInstances;

        // Smart instance selection: try to find a known good instance
        let selectedInstance = getPreferredInstance(candidateInstances);

        // Immediate redirection to the selected instance
        redirectToInstance(selectedInstance, path);

        // Start background availability check to update for future use
        setTimeout(() => {
            checkAndUpdateInstances(libredditInstances);
        }, 50);
    }

    function getPreferredInstance(instances) {
        // Get the most recently confirmed working instance
        const lastUsedInstance = localStorage.getItem('libreddit_last_working');

        if (lastUsedInstance && instances.includes(lastUsedInstance)) {
            // If we have a recently successful instance, prioritize it
            return lastUsedInstance;
        } else if (instances.length > 0) {
            // Otherwise pick the first instance from our list
            return instances[0];
        } else {
            // Absolute fallback
            return 'https://libreddit.kavin.rocks';
        }
    }

    function redirectToInstance(instance, path) {
        const redirectURL = instance + path;

        // Set a flag in sessionStorage to prevent redirect loops
        const currentAttempts = JSON.parse(sessionStorage.getItem('libreddit_redirect_attempts') || '[]');

        // If we've already tried this instance during this session, skip to next instance
        if (currentAttempts.includes(instance)) {
            handleFailedRedirect(instance, path);
            return;
        }

        // Add this instance to the attempts
        currentAttempts.push(instance);
        sessionStorage.setItem('libreddit_redirect_attempts', JSON.stringify(currentAttempts));

        // Quick health check before redirecting
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            // Start a timer for backup redirection
            const redirectTimeout = setTimeout(() => {
                // If the request is taking too long, try another instance
                handleFailedRedirect(instance, path);
            }, 800); // Short timeout for fast user experience

            // Check if instance is up
            GM_xmlhttpRequest({
                method: 'HEAD',
                url: instance,
                timeout: 700,
                onload: function(response) {
                    clearTimeout(redirectTimeout);
                    if (response.status >= 200 && response.status < 400) {
                        // Instance is up, redirect now
                        localStorage.setItem('libreddit_last_working', instance);
                        window.location.replace(redirectURL);
                    } else {
                        // Instance returned an error status
                        handleFailedRedirect(instance, path);
                    }
                },
                onerror: function() {
                    clearTimeout(redirectTimeout);
                    handleFailedRedirect(instance, path);
                },
                ontimeout: function() {
                    clearTimeout(redirectTimeout);
                    handleFailedRedirect(instance, path);
                }
            });
        } else {
            // Fallback if GM_xmlhttpRequest is not available
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 700);

                fetch(instance, {
                    method: 'HEAD',
                    signal: controller.signal,
                    mode: 'no-cors',
                    cache: 'no-store'
                })
                .then(() => {
                    clearTimeout(timeoutId);
                    localStorage.setItem('libreddit_last_working', instance);
                    window.location.replace(redirectURL);
                })
                .catch(() => {
                    clearTimeout(timeoutId);
                    handleFailedRedirect(instance, path);
                });

                // Set a backup redirection in case fetch hangs
                setTimeout(() => {
                    controller.abort();
                    handleFailedRedirect(instance, path);
                }, 800);
            } catch (e) {
                // Direct redirect as ultimate fallback
                window.location.replace(redirectURL);
            }
        }
    }

    function handleFailedRedirect(failedInstance, path) {
        // Remove this instance from working instances
        const workingInstances = JSON.parse(localStorage.getItem('libreddit_working_instances') || '[]');
        const updatedInstances = workingInstances.filter(i => i !== failedInstance);
        localStorage.setItem('libreddit_working_instances', JSON.stringify(updatedInstances));

        // Get all attempted instances in this session
        const attempts = JSON.parse(sessionStorage.getItem('libreddit_redirect_attempts') || '[]');

        // Get all defined instances
        const allInstances = [
            'https://libreddit.kavin.rocks',
            'https://libreddit.spike.codes',
            'https://libreddit.eu',
            'https://libreddit.projectsegfau.lt',
            'https://lr.vern.cc',
            'https://libreddit.northboot.xyz',
            'https://reddit.invak.id',
            'https://snoo.habedieeh.re',
            'https://libreddit.de',
            'https://libreddit.bus-hit.me',
            'https://libreddit.totaldarkness.net',
            'https://libreddit.privacy.com.de',
            'https://libreddit.domain.glass',
            'https://l.opnxng.com',
        ];

        // Find the next instance that hasn't been tried yet
        const nextInstance = allInstances.find(i => !attempts.includes(i));

        if (nextInstance) {
            // Try the next instance
            redirectToInstance(nextInstance, path);
        } else if (allInstances.length > 0) {
            // If all instances have been tried, just use the first one as a last resort
            const finalURL = allInstances[0] + path;
            window.location.replace(finalURL);
        } else {
            // If somehow we have no instances at all, stay on Reddit
            console.error('All Libreddit instances failed');
        }
    }

    // Function to check instances in the background and save working ones to localStorage
    function checkAndUpdateInstances(instances) {
        // Only update if we haven't checked recently
        const lastCheck = localStorage.getItem('libreddit_last_check');
        if (lastCheck && (Date.now() - parseInt(lastCheck) < 3600000)) {
            // Already checked within the last hour
            return;
        }

        const checkedInstances = [];
        let checksCompleted = 0;

        // Function to be called when all checks are done
        function finalizeChecks() {
            if (checkedInstances.length > 0) {
                localStorage.setItem('libreddit_working_instances', JSON.stringify(checkedInstances));
                localStorage.setItem('libreddit_last_check', Date.now().toString());
            }
        }

        // Check each instance with a slight delay to avoid overwhelming the browser
        instances.forEach((instance, index) => {
            setTimeout(() => {
                checkInstance(instance);
            }, index * 100);
        });

        function checkInstance(instance) {
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'HEAD',
                    url: instance,
                    timeout: 5000,
                    onload: function(response) {
                        if (response.status >= 200 && response.status < 400) {
                            checkedInstances.push(instance);
                        }
                        checksCompleted++;
                        if (checksCompleted === instances.length) {
                            finalizeChecks();
                        }
                    },
                    onerror: function() {
                        checksCompleted++;
                        if (checksCompleted === instances.length) {
                            finalizeChecks();
                        }
                    },
                    ontimeout: function() {
                        checksCompleted++;
                        if (checksCompleted === instances.length) {
                            finalizeChecks();
                        }
                    }
                });
            } else {
                fetch(instance, {
                    method: 'HEAD',
                    mode: 'no-cors',
                    cache: 'no-store',
                    timeout: 5000
                })
                .then(() => {
                    checkedInstances.push(instance);
                    checksCompleted++;
                    if (checksCompleted === instances.length) {
                        finalizeChecks();
                    }
                })
                .catch(() => {
                    checksCompleted++;
                    if (checksCompleted === instances.length) {
                        finalizeChecks();
                    }
                });
            }
        }
    }
})();