// ==UserScript==
// @name         Video management: examplesite
// @namespace    https://github.com/unmasked213/Misc-Scripts
// @version      5.1
// @description  Plays and pauses videos on examplesite pages, jumps to midpoint, hides short videos, manages video visibility, and toggles images
// @author       Unmasked213
// @include      /^https:\/\/.*examplesit.*\.[^\/]+\/a\/.*$/
// @grant        none
// @updateURL    https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/video_management_examplesite.user.js
// @downloadURL  https://raw.githubusercontent.com/unmasked213/Misc-Scripts/main/javascript/violentmonkey_userscripts/video_management_examplesite.user.js
// ==/UserScript==



(function() {
    'use strict';

    // Configurable values
    let videoLengthToHide = 59; // Default duration in seconds
    const TIME_BETWEEN_VIDEOS = 20; // Time in milliseconds
    const TIME_TO_PLAY = 20; // Time to play before pausing in milliseconds

    function isValidexamplesiteComURL() {
        const path = window.location.pathname;
        return path.startsWith('/a/');
    }

    if (isValidexamplesiteComURL()) {
        let isPaused = false;
        let currentIndex = 0;
        let videos = [];
        let hideShortVideosToggled = false;
        let hideUnloadedToggled = false;
        let hideImagesToggled = false;
        let hiddenVideos = [];
        let hiddenUnloadedVideos = [];
        let hiddenImages = [];

        function playAllVideos() {
            videos = document.querySelectorAll('video');
            currentIndex = 0;
            playNextVideo();
            updateVideoCount();
        }

        function playNextVideo() {
            if (!isPaused && currentIndex < videos.length) {
                const video = videos[currentIndex];
                video.play();
                video.scrollIntoView({ behavior: 'smooth', block: 'center' });

                setTimeout(() => {
                    video.pause();
                    currentIndex++;
                    if (!isPaused) {
                        setTimeout(playNextVideo, TIME_BETWEEN_VIDEOS);
                    }
                }, TIME_TO_PLAY);
            } else if (currentIndex >= videos.length) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
                buttonPlay.innerText = 'All ready';
                buttonPlay.style.color = '#44F8CA'; // Green
                buttonPlay.disabled = false;
            }
        }

        function jumpToMidpoint() {
            videos = document.querySelectorAll('video');
            currentIndex = 0;
            jumpToNextMidpoint();
            updateVideoCount();
        }

        let jumpPosition = 50; // Default to 50%

        function jumpToNextMidpoint() {
            if (!isPaused && currentIndex < videos.length) {
                const video = videos[currentIndex];
                video.currentTime = video.duration * (jumpPosition / 100);
                video.scrollIntoView({ behavior: 'smooth', block: 'center' });

                setTimeout(() => {
                    currentIndex++;
                    if (!isPaused) {
                        setTimeout(jumpToNextMidpoint, TIME_BETWEEN_VIDEOS);
                    }
                }, TIME_BETWEEN_VIDEOS);
            } else if (currentIndex >= videos.length) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
                jumpLabel.innerText = 'Jump to';
                jumpLabel.style.color = '#44F8CA'; // Green
                jumpLabel.disabled = false;
            }
        }

        function toggleHideUnloaded() {
            const videos = document.querySelectorAll('video');
            if (!hideUnloadedToggled) {
                videos.forEach(video => {
                    // Check if video hasn't been loaded (readyState < 1 means metadata hasn't loaded)
                    if (video.readyState < 1) {
                        const videoContainer = video.closest('.video-js');
                        if (videoContainer) {
                            videoContainer.style.display = 'none';
                            hiddenUnloadedVideos.push(videoContainer);
                        } else {
                            video.style.display = 'none';
                            hiddenUnloadedVideos.push(video);
                        }
                    }
                });
                buttonHideUnloaded.innerText = 'Show unloaded';
                buttonHideUnloaded.style.color = '#44F8CA'; // Green
            } else {
                hiddenUnloadedVideos.forEach(videoContainer => {
                    videoContainer.style.display = '';
                });
                hiddenUnloadedVideos = [];
                buttonHideUnloaded.innerText = 'Hide unloaded';
                buttonHideUnloaded.style.color = '#FFB581'; // Orange
            }
            hideUnloadedToggled = !hideUnloadedToggled;
            updateVideoCount();
        }

        function toggleHideImages() {
            const images = document.querySelectorAll('img');
            if (!hideImagesToggled) {
                images.forEach(image => {
                    // Don't hide interface-related images if any
                    if (!image.closest('.button-container')) {
                        image.style.display = 'none';
                        hiddenImages.push(image);
                    }
                });
                buttonHideImages.innerText = 'Show images';
                buttonHideImages.style.color = '#44F8CA'; // Green
            } else {
                hiddenImages.forEach(image => {
                    image.style.display = '';
                });
                hiddenImages = [];
                buttonHideImages.innerText = 'Hide images';
                buttonHideImages.style.color = '#FFB581'; // Orange
            }
            hideImagesToggled = !hideImagesToggled;
            updateVideoCount();
        }

        function getDurationFromSpan(video) {
            const videoDiv = video.closest('.video');
            if (!videoDiv) return null;

            const durationSpan = videoDiv.querySelector('.duration');
            if (!durationSpan) return null;

            const duration = durationSpan.textContent.trim();
            const [minutes, seconds] = duration.split(':').map(Number);
            return (minutes * 60) + seconds;
        }

        function toggleHideShortVideos() {
            const videos = document.querySelectorAll('video');
            if (!hideShortVideosToggled) {
                videos.forEach(video => {
                    const spanDuration = getDurationFromSpan(video);
                    const videoDuration = video.duration;

                    // Check if either duration is under the threshold
                    if ((spanDuration !== null && spanDuration < videoLengthToHide) ||
                        (videoDuration && videoDuration < videoLengthToHide)) {
                        const videoContainer = video.closest('.video-js');
                        if (videoContainer) {
                            videoContainer.style.display = 'none';
                            hiddenVideos.push(videoContainer);
                        } else {
                            video.style.display = 'none';
                            hiddenVideos.push(video);
                        }
                    }
                });
                thresholdLabel.innerText = 'Show all';
                thresholdLabel.style.color = '#44F8CA'; // Green

                // Critical: Make sure value remains visible with proper spacing
                thresholdValueContainer.style.display = '';
                thresholdInput.value = videoLengthToHide;
            } else {
                hiddenVideos.forEach(videoContainer => {
                    videoContainer.style.display = '';
                });
                hiddenVideos = [];
                thresholdLabel.innerText = 'Hide if under';
                thresholdLabel.style.color = '#FFB581'; // Orange

                // Critical: Make sure value remains visible with proper spacing
                thresholdValueContainer.style.display = '';
                thresholdInput.value = videoLengthToHide;
            }
            hideShortVideosToggled = !hideShortVideosToggled;
            updateVideoCount();
        }

        function updateVideoCount() {
            // Get video counts
            const videoContainers = document.querySelectorAll('.video-js');
            const allVideosCount = videoContainers.length;
            const visibleVideosCount = Array.from(videoContainers)
                .filter(container => {
                    const video = container.querySelector('video');
                    return container.style.display !== 'none' && video;
                })
                .length;
            const hiddenVideosCount = allVideosCount - visibleVideosCount;

            // Get image counts
            const allImages = document.querySelectorAll('img:not(.button-container img)');
            const visibleImagesCount = Array.from(allImages)
                .filter(img => img.style.display !== 'none')
                .length;
            const hiddenImagesCount = allImages.length - visibleImagesCount;

            // Create stats array with only non-zero values
            const stats = [];
            if (visibleVideosCount > 0) stats.push(`<span style="color:#44F8CA">${visibleVideosCount}</span> videos`);
            if (hiddenVideosCount > 0) stats.push(`<span style="color:#FFB581">${hiddenVideosCount}</span> videos hidden`);
            if (visibleImagesCount > 0) stats.push(`<span style="color:#44F8CA">${visibleImagesCount}</span> images`);
            if (hiddenImagesCount > 0) stats.push(`<span style="color:#FFB581">${hiddenImagesCount}</span> images hidden`);

            // Display stats
            videoCount.innerHTML = stats.join('<br>');
        }

        // Create a container for the buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.style.position = 'fixed';
        buttonContainer.style.top = '10px';
        buttonContainer.style.right = '10px';
        buttonContainer.style.zIndex = 1000;
        buttonContainer.style.padding = '10px';
        buttonContainer.style.backgroundColor = 'rgba(22, 24, 36, 0.85)';
        buttonContainer.style.backdropFilter = 'blur(12px)';
        buttonContainer.style.webkitBackdropFilter = 'blur(12px)';
        buttonContainer.style.borderRadius = '8px';
        buttonContainer.style.display = 'flex';
        buttonContainer.style.flexDirection = 'column';
        buttonContainer.style.gap = '6px';
        buttonContainer.style.alignItems = 'stretch';
        buttonContainer.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.2)';
        buttonContainer.style.width = '150px';

        // Add a basic button style
        const styleButton = (button) => {
            button.style.width = '100%';
            button.style.padding = '6px 0';
            button.style.boxSizing = 'border-box';
            button.style.transition = 'background-color 0.15s';
            button.style.borderRadius = '4px';
            button.addEventListener('mouseover', () => {
                button.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
            });
            button.addEventListener('mouseout', () => {
                button.style.backgroundColor = 'transparent';
            });
        };

        // Stats display
        const videoCount = document.createElement('div');
        videoCount.style.color = 'white';
        videoCount.style.fontSize = '13px';
        videoCount.style.lineHeight = '1.4';
        videoCount.style.width = '100%';
        videoCount.style.padding = '6px 0';
        videoCount.style.boxSizing = 'border-box';
        videoCount.innerText = '0 videos';

        // Separator
        const separator = document.createElement('hr');
        separator.style.width = '100%';
        separator.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        separator.style.margin = '0';

        // Play all button
        const buttonPlay = document.createElement('button');
        buttonPlay.innerText = 'Play all';
        buttonPlay.style.backgroundColor = 'transparent';
        buttonPlay.style.color = '#FFB581';
        buttonPlay.style.border = 'none';
        buttonPlay.style.cursor = 'pointer';
        buttonPlay.style.fontSize = '14px';
        buttonPlay.style.textAlign = 'left';
        styleButton(buttonPlay);

        // Jump % input
        const jumpInput = document.createElement('input');
        jumpInput.type = 'number';
        jumpInput.value = jumpPosition;
        jumpInput.min = 0;
        jumpInput.max = 100;
        jumpInput.step = '5';
        jumpInput.addEventListener('input', () => {
            jumpPosition = Math.max(0, Math.min(100, parseInt(jumpInput.value, 10) || 0));
            jumpInput.value = jumpPosition;
        });

        // Instead of complex row, create a simpler jump container
        const jumpContainer = document.createElement('div');
        jumpContainer.style.display = 'flex';
        jumpContainer.style.alignItems = 'center';
        jumpContainer.style.width = '100%';
        jumpContainer.style.justifyContent = 'space-between'; // Ensure space between label and value

        const jumpLabel = document.createElement('div');
        jumpLabel.innerText = 'Jump to';
        jumpLabel.style.color = '#FFB581';
        jumpLabel.style.fontSize = '14px';
        jumpLabel.style.cursor = 'pointer';
        jumpLabel.style.flexGrow = '1'; // Take available space

        const jumpValueContainer = document.createElement('div');
        jumpValueContainer.style.display = 'flex';
        jumpValueContainer.style.alignItems = 'center';
        jumpValueContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
        jumpValueContainer.style.borderRadius = '4px';
        jumpValueContainer.style.padding = '2px 4px';
        jumpValueContainer.style.position = 'relative';
        jumpValueContainer.style.minWidth = '40px'; // Ensure minimum width
        jumpValueContainer.style.width = '40px'; // Fixed width
        jumpValueContainer.style.marginLeft = '5px'; // Space from label

        jumpInput.style.width = '28px';
        jumpInput.style.backgroundColor = 'transparent';
        jumpInput.style.border = 'none';
        jumpInput.style.color = '#FFB581';
        jumpInput.style.padding = '0 14px 0 4px';
        jumpInput.style.textAlign = 'right';
        jumpInput.style.appearance = 'textfield';
        jumpInput.style.fontSize = '14px';
        jumpInput.style.fontWeight = 'bold';
        jumpInput.style.outline = 'none';

        const jumpUnit = document.createElement('span');
        jumpUnit.innerText = '%';
        jumpUnit.style.position = 'absolute';
        jumpUnit.style.right = '6px';
        jumpUnit.style.color = '#FFB581';
        jumpUnit.style.pointerEvents = 'none';

        jumpValueContainer.appendChild(jumpInput);
        jumpValueContainer.appendChild(jumpUnit);
        jumpContainer.appendChild(jumpLabel);
        jumpContainer.appendChild(jumpValueContainer);

        // Hide unloaded button
        const buttonHideUnloaded = document.createElement('button');
        buttonHideUnloaded.innerText = 'Hide unloaded';
        buttonHideUnloaded.style.backgroundColor = 'transparent';
        buttonHideUnloaded.style.color = '#FFB581';
        buttonHideUnloaded.style.border = 'none';
        buttonHideUnloaded.style.cursor = 'pointer';
        buttonHideUnloaded.style.fontSize = '14px';
        buttonHideUnloaded.style.textAlign = 'left';
        styleButton(buttonHideUnloaded);

        // Hide images button
        const buttonHideImages = document.createElement('button');
        buttonHideImages.innerText = 'Hide images';
        buttonHideImages.style.backgroundColor = 'transparent';
        buttonHideImages.style.color = '#FFB581';
        buttonHideImages.style.border = 'none';
        buttonHideImages.style.cursor = 'pointer';
        buttonHideImages.style.fontSize = '14px';
        buttonHideImages.style.textAlign = 'left';
        styleButton(buttonHideImages);

        // Create container for threshold
        const thresholdContainer = document.createElement('div');
        thresholdContainer.style.display = 'flex';
        thresholdContainer.style.alignItems = 'center';
        thresholdContainer.style.width = '100%';
        thresholdContainer.style.justifyContent = 'space-between'; // Ensure space between label and value

        const thresholdLabel = document.createElement('div');
        thresholdLabel.innerText = 'Hide if under';
        thresholdLabel.style.color = '#FFB581';
        thresholdLabel.style.fontSize = '14px';
        thresholdLabel.style.cursor = 'pointer';
        thresholdLabel.style.flexGrow = '1'; // Take available space

        // Hide short videos threshold input
        const thresholdInput = document.createElement('input');
        thresholdInput.type = 'number';
        thresholdInput.value = videoLengthToHide;
        thresholdInput.step = '30';
        thresholdInput.addEventListener('input', () => {
            videoLengthToHide = parseInt(thresholdInput.value, 10) || 0;
        });

        const thresholdValueContainer = document.createElement('div');
        thresholdValueContainer.style.display = 'flex';
        thresholdValueContainer.style.alignItems = 'center';
        thresholdValueContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
        thresholdValueContainer.style.borderRadius = '4px';
        thresholdValueContainer.style.padding = '2px 4px';
        thresholdValueContainer.style.position = 'relative';
        thresholdValueContainer.style.minWidth = '40px'; // Ensure minimum width
        thresholdValueContainer.style.width = '40px'; // Fixed width
        thresholdValueContainer.style.marginLeft = '5px'; // Space from label

        thresholdInput.style.width = '28px';
        thresholdInput.style.backgroundColor = 'transparent';
        thresholdInput.style.border = 'none';
        thresholdInput.style.color = '#FFB581';
        thresholdInput.style.padding = '0 14px 0 4px';
        thresholdInput.style.textAlign = 'right';
        thresholdInput.style.appearance = 'textfield';
        thresholdInput.style.fontSize = '14px';
        thresholdInput.style.fontWeight = 'bold';
        thresholdInput.style.outline = 'none';

        const thresholdUnit = document.createElement('span');
        thresholdUnit.innerText = 's';
        thresholdUnit.style.position = 'absolute';
        thresholdUnit.style.right = '6px';
        thresholdUnit.style.color = '#FFB581';
        thresholdUnit.style.pointerEvents = 'none';

        thresholdValueContainer.appendChild(thresholdInput);
        thresholdValueContainer.appendChild(thresholdUnit);
        thresholdContainer.appendChild(thresholdLabel);
        thresholdContainer.appendChild(thresholdValueContainer);

        // Add event listeners for actions
        buttonPlay.addEventListener('click', () => {
            if (buttonPlay.style.color === '#71ADFF') { // Blue
                isPaused = true;
                buttonPlay.innerText = 'Paused';
                buttonPlay.style.color = '#FFB581'; // Orange
            } else if (buttonPlay.style.color === '#FFB581') { // Orange
                isPaused = false;
                buttonPlay.innerText = 'Working...';
                buttonPlay.style.color = '#71ADFF'; // Blue
                playNextVideo();
            } else {
                buttonPlay.innerText = 'Working...';
                buttonPlay.style.color = '#71ADFF'; // Blue
                buttonPlay.disabled = true;
                playAllVideos();
            }
        });

        jumpLabel.addEventListener('click', () => {
            if (jumpLabel.style.color === '#71ADFF') { // Blue
                isPaused = true;
                jumpLabel.innerText = 'Paused';
                jumpLabel.style.color = '#FFB581'; // Orange

                // Critical: Make sure value remains visible
                jumpValueContainer.style.display = '';
                jumpInput.value = jumpPosition;
            } else if (jumpLabel.style.color === '#FFB581') { // Orange
                isPaused = false;
                jumpLabel.innerText = 'Working...';
                jumpLabel.style.color = '#71ADFF'; // Blue

                // Critical: Make sure value remains visible
                jumpValueContainer.style.display = '';
                jumpInput.value = jumpPosition;
                jumpToNextMidpoint();
            } else {
                jumpLabel.innerText = 'Working...';
                jumpLabel.style.color = '#71ADFF'; // Blue

                // Critical: Make sure value remains visible
                jumpValueContainer.style.display = '';
                jumpInput.value = jumpPosition;
                jumpToMidpoint();
            }
        });

        thresholdLabel.addEventListener('click', () => {
            toggleHideShortVideos();
        });

        buttonHideUnloaded.addEventListener('click', toggleHideUnloaded);
        buttonHideImages.addEventListener('click', toggleHideImages);

        // Assemble the container
        buttonContainer.appendChild(videoCount);
        buttonContainer.appendChild(separator);
        buttonContainer.appendChild(buttonPlay);
        buttonContainer.appendChild(jumpContainer);
        buttonContainer.appendChild(buttonHideUnloaded);
        buttonContainer.appendChild(buttonHideImages);
        buttonContainer.appendChild(thresholdContainer);

        document.body.appendChild(buttonContainer);

        // Auto-toggle hide short videos and images at startup
        toggleHideShortVideos();
        toggleHideImages();

        updateVideoCount();
    }
})();