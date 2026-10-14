(function () {
  const PEAK_BARS = 34;
  const PEAK_MS = 50;
  const AUDIO_EXT = /\.(webm|ogg|oga|mp4|m4a|wav|mp3|aac|opus|flac)$/i;
  const hooked = new WeakSet();

  function maxRecordSeconds() {
    try {
      const value = Number(save_data.shop.setting.donate.record.second);
      return Number.isFinite(value) && value > 0 ? value : 30;
    } catch (e) {
      return 30;
    }
  }

  function toastError(message) {
    if (window.alertify && alertify.error) alertify.error(message);
    else window.alert(message);
  }

  function toastSuccess(message) {
    if (window.alertify && alertify.success) alertify.success(message);
  }

  function switchToVoiceTab() {
    const tab = document.querySelector('.donate_input_method .method_tabs button.item:nth-child(2)');
    if (tab && !tab.classList.contains('active')) tab.click();
  }

  function pickRecorderMime() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  function isDirectUploadType(type) {
    return /webm|mp4|m4a|ogg|oga/i.test(type || '');
  }

  function encodePeaks(frames) {
    if (frames.length < PEAK_BARS) return '';
    const block = frames.length / PEAK_BARS;
    const peaks = [];
    let max = 0;
    for (let i = 0; i < PEAK_BARS; i++) {
      const end = Math.floor((i + 1) * block);
      let peak = 0;
      for (let j = Math.floor(i * block); j < end; j++) {
        if (frames[j] > peak) peak = frames[j];
      }
      peaks.push(peak);
      if (peak > max) max = peak;
    }
    if (!(max > 0)) return '';
    let out = '';
    for (let k = 0; k < PEAK_BARS; k++) {
      out += Math.min(9, Math.round((peaks[k] / max) * 9));
    }
    return out;
  }

  function peaksFromBuffer(buffer) {
    const data = buffer.getChannelData(0);
    const frameSamples = Math.max(1, Math.floor(buffer.sampleRate * (PEAK_MS / 1000)));
    const frames = [];
    for (let i = 0; i < data.length; i += frameSamples) {
      let peak = 0;
      const end = Math.min(data.length, i + frameSamples);
      for (let j = i; j < end; j++) {
        const abs = Math.abs(data[j]);
        if (abs > peak) peak = abs;
      }
      frames.push(peak);
    }
    return encodePeaks(frames);
  }

  function decodeAudioFile(file) {
    return file.arrayBuffer().then(function (bytes) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      return ctx.decodeAudioData(bytes.slice(0)).finally(function () {
        if (ctx.state !== 'closed') ctx.close();
      });
    });
  }

  function recordBufferToBlob(buffer) {
    return new Promise(function (resolve, reject) {
      const mime = pickRecorderMime();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.createMediaStreamDestination();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(dest);

      let recorder;
      try {
        recorder = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : {});
      } catch (err) {
        ctx.close();
        reject(err);
        return;
      }

      const chunks = [];
      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = function (event) {
        ctx.close();
        reject(event.error || new Error('Không mã hóa được file audio'));
      };
      recorder.onstop = function () {
        ctx.close();
        resolve(new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' }));
      };

      recorder.start();
      source.onended = function () {
        setTimeout(function () {
          if (recorder.state !== 'inactive') recorder.stop();
        }, 40);
      };
      ctx.resume().then(function () {
        source.start();
      }).catch(reject);
    });
  }

  function bindPreviewPlayer(audioPlayer) {
    audioPlayer.preload = 'metadata';
    audioPlayer.load();
    $('.btn_audio_play').html('<i class="fa-solid fa-play"></i>');
    $('.audio_progress_bar').css('width', '0%');
    if (typeof updateAudioTimeUI === 'function') updateAudioTimeUI();

    audioPlayer.onloadedmetadata = function () {
      if (typeof updateAudioTimeUI === 'function') updateAudioTimeUI();
    };
    audioPlayer.ondurationchange = function () {
      if (typeof updateAudioTimeUI === 'function') updateAudioTimeUI();
    };
    audioPlayer.ontimeupdate = function () {
      if (typeof updateAudioProgressUI === 'function') updateAudioProgressUI();
    };
    audioPlayer.onplay = function () {
      $('.btn_audio_play').html('<i class="fa-solid fa-pause"></i>');
    };
    audioPlayer.onpause = function () {
      $('.btn_audio_play').html('<i class="fa-solid fa-play"></i>');
    };
    audioPlayer.onended = function () {
      $('.btn_audio_play').html('<i class="fa-solid fa-play"></i>');
    };
  }

  function showPreview(blob, duration, peaks) {
    window.donateAudioBlob = blob;
    window.donateVoicePreviewDuration = duration;
    window.donateVoicePeaks = peaks;
    window.donateVoicePeakFrames = [];

    const audioPlayer = document.getElementById('voice_audio_preview');
    if (!audioPlayer) {
      toastError('Không tìm thấy trình phát ghi âm trên trang.');
      return;
    }

    audioPlayer.src = URL.createObjectURL(blob);
    bindPreviewPlayer(audioPlayer);
    $('.voice_record_wrapper .voice_state').addClass('hide');
    $('.voice_record_wrapper .preview').removeClass('hide');
  }

  function setVoiceState(name) {
    $('.voice_record_wrapper .voice_state').addClass('hide');
    $('.voice_record_wrapper .' + name).removeClass('hide');
  }

  function fmt(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(1);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function sliceBuffer(buffer, start, end) {
    const sr = buffer.sampleRate;
    const s = Math.max(0, Math.floor(start * sr));
    const e = Math.min(buffer.length, Math.floor(end * sr));
    const out = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length: Math.max(1, e - s),
      sampleRate: sr
    });
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      out.copyToChannel(buffer.getChannelData(c).subarray(s, e), c);
    }
    return out;
  }

  function drawWaveform(canvas, buffer) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);

    const data = buffer.getChannelData(0);
    const bins = Math.max(1, Math.floor(w));
    const step = Math.max(1, Math.floor(data.length / bins));
    const peaks = new Float32Array(bins);
    let max = 0;
    for (let i = 0; i < bins; i++) {
      let p = 0;
      const to = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < to; j++) {
        const a = Math.abs(data[j]);
        if (a > p) p = a;
      }
      peaks[i] = p;
      if (p > max) max = p;
    }
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#818cf8';
    for (let x = 0; x < bins; x++) {
      const bar = Math.max(1, (peaks[x] / (max || 1)) * (h - 6));
      g.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }

  // Mở bảng crop. Resolve AudioBuffer đã cắt, hoặc null nếu người dùng hủy.
  function openCropper(buffer, maxSeconds) {
    return new Promise(function (resolve) {
      const duration = buffer.duration;
      const MIN_LEN = 0.5;
      const state = { start: 0, end: Math.min(maxSeconds, duration) };

      const overlay = document.createElement('div');
      overlay.className = 'zad-crop-overlay';
      overlay.innerHTML =
        '<div class="zad-crop-card" role="dialog" aria-modal="true">' +
          '<div class="zad-crop-title">File dài ' + duration.toFixed(1) + 's, giới hạn ' + maxSeconds + 's</div>' +
          '<div class="zad-crop-sub">Kéo khung để chọn đoạn muốn dùng (kéo hai mép để chỉnh độ dài).</div>' +
          '<div class="zad-crop-track">' +
            '<canvas class="zad-crop-canvas"></canvas>' +
            '<div class="zad-crop-sel">' +
              '<div class="zad-crop-handle zad-left" data-drag="left"></div>' +
              '<div class="zad-crop-handle zad-right" data-drag="right"></div>' +
              '<div class="zad-crop-playhead"></div>' +
            '</div>' +
          '</div>' +
          '<div class="zad-crop-info"></div>' +
          '<div class="zad-crop-actions">' +
            '<button type="button" class="zad-btn zad-play">▶ Nghe thử đoạn này</button>' +
            '<span class="zad-spacer"></span>' +
            '<button type="button" class="zad-btn zad-cancel">Hủy</button>' +
            '<button type="button" class="zad-btn zad-primary zad-ok">Dùng đoạn này</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);

      const track = overlay.querySelector('.zad-crop-track');
      const canvas = overlay.querySelector('.zad-crop-canvas');
      const sel = overlay.querySelector('.zad-crop-sel');
      const playhead = overlay.querySelector('.zad-crop-playhead');
      const info = overlay.querySelector('.zad-crop-info');
      const playBtn = overlay.querySelector('.zad-play');

      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      let src = null;
      let raf = 0;
      let playStart = 0;

      function render() {
        sel.style.left = (state.start / duration * 100) + '%';
        sel.style.width = ((state.end - state.start) / duration * 100) + '%';
        info.textContent = fmt(state.start) + ' → ' + fmt(state.end) +
          '  ·  dài ' + (state.end - state.start).toFixed(1) + 's / ' + maxSeconds + 's';
      }

      function stopPlayback() {
        cancelAnimationFrame(raf);
        if (src) {
          src.onended = null;
          try { src.stop(); } catch (e) {}
          try { src.disconnect(); } catch (e) {}
          src = null;
        }
        playhead.style.display = 'none';
        playBtn.textContent = '▶ Nghe thử đoạn này';
      }

      function startPlayback() {
        stopPlayback();
        const len = state.end - state.start;
        src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = stopPlayback;
        playBtn.textContent = '■ Dừng';
        playhead.style.display = 'block';
        ctx.resume().then(function () {
          if (!src) return;
          playStart = ctx.currentTime;
          src.start(0, state.start, len);
          (function tick() {
            const t = Math.min(1, (ctx.currentTime - playStart) / len);
            playhead.style.left = (t * 100) + '%';
            raf = requestAnimationFrame(tick);
          })();
        });
      }

      function close(result) {
        stopPlayback();
        document.removeEventListener('keydown', onKey, true);
        if (ctx.state !== 'closed') ctx.close();
        overlay.remove();
        resolve(result);
      }

      function onKey(event) {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close(null);
        }
      }
      document.addEventListener('keydown', onKey, true);

      // Kéo khung / mép
      let drag = null;
      sel.addEventListener('pointerdown', function (event) {
        const handle = event.target.closest('[data-drag]');
        drag = {
          mode: handle ? handle.dataset.drag : 'move',
          x: event.clientX,
          start: state.start,
          end: state.end
        };
        stopPlayback();
        sel.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      sel.addEventListener('pointermove', function (event) {
        if (!drag) return;
        const dt = (event.clientX - drag.x) / track.clientWidth * duration;
        if (drag.mode === 'left') {
          state.start = Math.min(drag.end - MIN_LEN, Math.max(0, drag.end - maxSeconds, drag.start + dt));
        } else if (drag.mode === 'right') {
          state.end = Math.max(drag.start + MIN_LEN, Math.min(duration, drag.start + maxSeconds, drag.end + dt));
        } else {
          const len = drag.end - drag.start;
          const s = Math.min(duration - len, Math.max(0, drag.start + dt));
          state.start = s;
          state.end = s + len;
        }
        render();
      });
      ['pointerup', 'pointercancel'].forEach(function (type) {
        sel.addEventListener(type, function () { drag = null; });
      });

      // Bấm lên waveform để dời khung tới đó
      track.addEventListener('pointerdown', function (event) {
        if (event.target.closest('.zad-crop-sel')) return;
        const rect = track.getBoundingClientRect();
        const center = (event.clientX - rect.left) / rect.width * duration;
        const len = state.end - state.start;
        const s = Math.min(duration - len, Math.max(0, center - len / 2));
        state.start = s;
        state.end = s + len;
        stopPlayback();
        render();
      });

      playBtn.addEventListener('click', function () {
        if (src) stopPlayback();
        else startPlayback();
      });
      overlay.querySelector('.zad-cancel').addEventListener('click', function () { close(null); });
      overlay.querySelector('.zad-ok').addEventListener('click', function () {
        close(sliceBuffer(buffer, state.start, state.end));
      });

      drawWaveform(canvas, buffer);
      render();
      window.addEventListener('resize', function onResize() {
        if (!overlay.isConnected) return window.removeEventListener('resize', onResize);
        drawWaveform(canvas, buffer);
      });
    });
  }

  function finalizeBuffer(file, buffer, cropped) {
    const peaks = peaksFromBuffer(buffer);
    if (!cropped && isDirectUploadType(file.type)) {
      return Promise.resolve({ blob: file, duration: buffer.duration, peaks: peaks });
    }
    return recordBufferToBlob(buffer).then(function (blob) {
      return { blob: blob, duration: buffer.duration, peaks: peaks };
    });
  }

  function applyFile(file) {
    switchToVoiceTab();
    const maxSeconds = maxRecordSeconds();
    setVoiceState('loading');

    decodeAudioFile(file)
      .then(function (buffer) {
        if (!(buffer.duration > 0)) throw new Error('Không đọc được thời lượng file.');

        if (buffer.duration > maxSeconds + 0.25) {
          setVoiceState('idle');
          return openCropper(buffer, maxSeconds).then(function (cropped) {
            if (!cropped) {
              return null;
            }
            setVoiceState('loading');
            toastSuccess('Đang xử lý đoạn đã cắt (mất khoảng bằng độ dài đoạn)…');
            return finalizeBuffer(file, cropped, true);
          });
        }
        return finalizeBuffer(file, buffer, false);
      })
      .then(function (result) {
        if (!result) {
          setVoiceState('idle');
          return;
        }
        showPreview(result.blob, result.duration, result.peaks);
        toastSuccess('Đã nạp file. Bấm xác nhận để gắn vào donate.');
      })
      .catch(function (err) {
        setVoiceState('idle');
        toastError((err && err.message) || 'Không dùng được file audio này.');
      });
  }

  function pickAudioFile(dataTransfer) {
    const files = dataTransfer && dataTransfer.files ? Array.from(dataTransfer.files) : [];
    return files.find(function (file) {
      return (file.type && file.type.indexOf('audio/') === 0) || AUDIO_EXT.test(file.name || '');
    }) || null;
  }

  function enhanceWrapper(wrapper) {
    if (!wrapper || hooked.has(wrapper)) return;
    hooked.add(wrapper);

    const hint = document.createElement('div');
    hint.className = 'zad-drop-hint';
    hint.innerHTML = 'Kéo file audio vào đây, hoặc <button type="button" class="zad-pick">chọn file</button>. Không cần bật micro.';

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.webm,.ogg,.mp3,.wav,.m4a,.mp4,.aac,.opus,.flac';
    input.className = 'zad-file-input';

    const idle = wrapper.querySelector('.voice_state.idle');
    if (idle) idle.appendChild(hint);
    else wrapper.appendChild(hint);
    wrapper.appendChild(input);

    hint.querySelector('.zad-pick').addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      input.click();
    });

    input.addEventListener('change', function () {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) applyFile(file);
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      wrapper.addEventListener(type, function (event) {
        if (!pickAudioFile(event.dataTransfer) && !(event.dataTransfer && event.dataTransfer.types && [...event.dataTransfer.types].includes('Files'))) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        wrapper.classList.add('zad-dragover');
      });
    });

    ['dragleave', 'drop'].forEach(function (type) {
      wrapper.addEventListener(type, function () {
        wrapper.classList.remove('zad-dragover');
      });
    });

    wrapper.addEventListener('drop', function (event) {
      const file = pickAudioFile(event.dataTransfer);
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      applyFile(file);
    });
  }

  function scan() {
    document.querySelectorAll('.voice_record_wrapper').forEach(enhanceWrapper);
  }

  scan();
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
