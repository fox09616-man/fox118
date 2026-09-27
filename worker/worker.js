export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const BOT_TOKEN = env.BOT_TOKEN;
    const GITHUB_TOKEN = env.GITHUB_TOKEN;
    const BOT_PASSWORD = env.BOT_PASSWORD;
    const GITHUB_REPO = "fox09616-man/fox118";
    const GITHUB_WORKFLOW = "compress.yml";
    const RESOLUTIONS = ["240", "360", "480", "720", "1080"];

    try {
      const update = await request.json();

      // استقبال فيديو أو ملف فيديو مباشرة.
      if (
        update.message &&
        (update.message.video ||
          (update.message.document &&
            (update.message.document.mime_type || "").startsWith("video/")))
      ) {
        const chatId = update.message.chat.id;
        const isAuthorized = await env.SESSIONS.get(`authorized:${chatId}`);

        if (!isAuthorized) {
          await sendMessage(BOT_TOKEN, chatId, "🔒 هذا البوت خاص. أرسل كلمة المرور للمتابعة:");
          return ok();
        }

        const defaultName = extractDefaultName(update.message);
        const preset = await getPreset(env, chatId);

        // وضع الإعداد التلقائي: يستعمل الإعداد المحفوظ مباشرة.
        if (preset && preset.active) {
          const finalName = buildAutomaticName(preset, defaultName);

          const autoSession = {
            message_id: update.message.message_id,
            url: "",
            codec: preset.codec || "av1",
            encode_mode: preset.encode_mode || "nofilters",
            filter_profile:
              preset.filter_profile ||
              (preset.encode_mode === "filters" ? "realistic" : "none"),
            preset: preset.preset || preset.av1_preset || "8",
            encode_method: preset.encode_method || "crf",
            target_value: preset.target_value || "28",
            resolution: preset.resolution || "480",
            filename: finalName,
            auto_advance_episode: preset.auto_naming === "series",
            pending_confirmation: false,
          };

          await sendMessage(BOT_TOKEN, chatId, `📤 جارٍ إرسال المهمة تلقائياً: ${finalName}`);
          await finalizeAndTrigger(
            env,
            BOT_TOKEN,
            GITHUB_TOKEN,
            GITHUB_REPO,
            GITHUB_WORKFLOW,
            chatId,
            autoSession,
          );
          return ok();
        }

        // جلسة يدوية جديدة.
        await setSession(env, chatId, {
          message_id: update.message.message_id,
          url: "",
          default_name: defaultName,
          pending_confirmation: false,
        });
        await sendCodecKeyboard(BOT_TOKEN, chatId);
        return ok();
      }

      // الرسائل النصية والأوامر والمدخلات الرقمية.
      if (update.message && update.message.text !== undefined) {
        const chatId = update.message.chat.id;
        const text = update.message.text.trim();
        const isAuthorized = await env.SESSIONS.get(`authorized:${chatId}`);

        if (!isAuthorized) {
          if (text === BOT_PASSWORD) {
            await env.SESSIONS.put(`authorized:${chatId}`, "true");
            await sendMessage(BOT_TOKEN, chatId, "✅ تم التحقق بنجاح. أرسل /start للبدء.");
          } else {
            await sendMessage(BOT_TOKEN, chatId, "🔒 هذا البوت خاص. أرسل كلمة المرور للمتابعة:");
          }
          return ok();
        }

        const session = (await getSession(env, chatId)) || {};

        // ★★★ قبول أي رابط ★★★
        if (isAnyLink(text)) {
          if (session.awaiting_preset || session.awaiting_target_value || 
              session.awaiting_res || session.awaiting_filename || 
              session.awaiting_series_title || session.awaiting_episode_start ||
              session.pending_confirmation) {
            await sendMessage(BOT_TOKEN, chatId, "⚠️ أنت في منتصف عملية إعداد. أكمل الإعداد أولاً أو ألغِ العملية.");
            return ok();
          }

          const preset = await getPreset(env, chatId);
          const linkInfo = extractLinkInfo(text);
          const linkSession = {
            message_id: "",
            url: text,
            default_name: linkInfo.name,
            pending_confirmation: false,
          };

          if (preset && preset.active) {
            const finalName = buildAutomaticName(preset, linkSession.default_name || "video");
            const autoSession = {
              message_id: "",
              url: text,
              codec: preset.codec || "av1",
              encode_mode: preset.encode_mode || "nofilters",
              filter_profile:
                preset.filter_profile ||
                (preset.encode_mode === "filters" ? "realistic" : "none"),
              preset: preset.preset || preset.av1_preset || "8",
              encode_method: preset.encode_method || "crf",
              target_value: preset.target_value || "28",
              resolution: preset.resolution || "480",
              filename: finalName,
              auto_advance_episode: preset.auto_naming === "series",
              pending_confirmation: false,
            };
            await sendMessage(BOT_TOKEN, chatId, `📤 جارٍ معالجة الرابط تلقائياً: ${finalName}`);
            await finalizeAndTrigger(env, BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW, chatId, autoSession);
          } else {
            await setSession(env, chatId, linkSession);
            await sendCodecKeyboard(BOT_TOKEN, chatId);
          }
          return ok();
        }
        // ★★★ نهاية قبول الروابط ★★★

        // التعامل مع رسائل التأكيد
        if (session.pending_confirmation) {
          if (text === "/confirm" || text === "✅ تأكيد") {
            session.pending_confirmation = false;
            await setSession(env, chatId, session);
            await sendMessage(BOT_TOKEN, chatId, "✅ تم تأكيد العملية. جارٍ الإرسال...");
            await finalizeAndTrigger(
              env,
              BOT_TOKEN,
              GITHUB_TOKEN,
              GITHUB_REPO,
              GITHUB_WORKFLOW,
              chatId,
              session,
            );
            return ok();
          } else if (text === "/cancel" || text === "🚫 إلغاء") {
            await deleteSession(env, chatId);
            await sendMessage(BOT_TOKEN, chatId, "🚫 تم إلغاء العملية.");
            return ok();
          } else {
            await sendMessage(BOT_TOKEN, chatId, "⚠️ الرجاء اختيار تأكيد أو إلغاء العملية:");
            return ok();
          }
        }

        // الأوامر
        if (text === "/start") {
          await sendMessage(BOT_TOKEN, chatId, startMessage(await getPreset(env, chatId)));
          return ok();
        }

        if (text === "/setup" || text === "/settings") {
          await setSession(env, chatId, { configuring_preset: true, pending_confirmation: false });
          await sendCodecKeyboard(BOT_TOKEN, chatId);
          return ok();
        }

        if (text === "/preset") {
          await sendMessage(BOT_TOKEN, chatId, presetStatusText(await getPreset(env, chatId)));
          return ok();
        }

        if (text === "/auto_off") {
          const preset = await getPreset(env, chatId);
          if (!preset) {
            await sendMessage(BOT_TOKEN, chatId, "لا يوجد إعداد محفوظ أصلاً.");
          } else {
            preset.active = false;
            await setPreset(env, chatId, preset);
            await sendMessage(BOT_TOKEN, chatId, "⏸️ تم إيقاف الوضع التلقائي. أرسل فيديو وستُسأل عن الإعدادات.");
          }
          return ok();
        }

        if (text === "/auto_on") {
          const preset = await getPreset(env, chatId);
          if (!preset) {
            await sendMessage(BOT_TOKEN, chatId, "لا يوجد إعداد محفوظ. استخدم /setup أولاً.");
          } else {
            preset.active = true;
            await setPreset(env, chatId, preset);
            await sendMessage(BOT_TOKEN, chatId, `▶️ تم تفعيل الوضع التلقائي.\n${presetStatusText(preset)}`);
          }
          return ok();
        }

        if (text === "/cancel") {
          await deleteSession(env, chatId);
          await sendMessage(BOT_TOKEN, chatId, "🚫 تم إلغاء العملية.");
          return ok();
        }

        // بقية المعالجات...
        if (session.awaiting_series_title) {
          const seriesTitle = cleanFileName(text);
          if (!seriesTitle) {
            await sendMessage(BOT_TOKEN, chatId, "📝 أرسل اسماً صحيحاً للمسلسل، مثل: Solo Leveling S02\n\nللإلغاء أرسل /cancel");
            return ok();
          }
          session.series_title = seriesTitle;
          session.awaiting_series_title = false;
          session.awaiting_episode_start = true;
          await setSession(env, chatId, session);
          await sendMessage(BOT_TOKEN, chatId, `✅ اسم السلسلة: ${seriesTitle}\n🔢 أرسل رقم الحلقة الأولى، مثل: 1\n\nللإلغاء أرسل /cancel`);
          return ok();
        }

        if (session.awaiting_episode_start) {
          if (!/^[1-9]\d{0,5}$/.test(text)) {
            await sendMessage(BOT_TOKEN, chatId, "🔢 أرسل رقم حلقة موجباً فقط، مثل: 1 أو 12.\n\nللإلغاء أرسل /cancel");
            return ok();
          }
          session.next_episode = Number.parseInt(text, 10);
          session.awaiting_episode_start = false;
          await setSession(env, chatId, session);
          await savePresetAndConfirm(env, BOT_TOKEN, chatId, session);
          return ok();
        }

        if (session.awaiting_preset) {
          const codec = session.codec || "av1";
          if (!isValidPreset(codec, text)) {
            await sendMessage(BOT_TOKEN, chatId, "أرسل رقم سرعة AV1 من 0 إلى 13 فقط:\n\nللإلغاء أرسل /cancel");
            return ok();
          }

          session.preset = text;
          session.awaiting_preset = false;
          await setSession(env, chatId, session);
          await sendMessage(BOT_TOKEN, chatId, `✅ تم تسجيل AV1 preset: ${text}`);
          await sendEncodeMethodKeyboard(BOT_TOKEN, chatId, codec);
          return ok();
        }

        if (session.awaiting_target_value) {
          if (!isValidTargetValue(session.codec, session.encode_method, text)) {
            await sendMessage(BOT_TOKEN, chatId, targetValueHint(session.codec, session.encode_method) + "\n\nللإلغاء أرسل /cancel");
            return ok();
          }

          session.target_value = text;
          session.awaiting_target_value = false;
          await setSession(env, chatId, session);

          if (session.codec === "audio") {
            if (session.configuring_preset) {
              await sendAutoNamingKeyboard(BOT_TOKEN, chatId);
            } else {
              session.awaiting_filename = true;
              await setSession(env, chatId, session);
              await promptFilename(BOT_TOKEN, chatId, null, session.default_name, false);
            }
          } else {
            await sendMessage(BOT_TOKEN, chatId, `✅ تم تسجيل القيمة: ${text}`);
            await sendQualityKeyboard(BOT_TOKEN, chatId, RESOLUTIONS);
          }
          return ok();
        }

        if (session.awaiting_res) {
          if (!isValidResolution(text)) {
            await sendMessage(BOT_TOKEN, chatId, "أرسل ارتفاعاً صحيحاً بين 144 و2160، مثل 550:\n\nللإلغاء أرسل /cancel");
            return ok();
          }
          session.resolution = text;
          session.awaiting_res = false;
          await setSession(env, chatId, session);
          await continueAfterResolution(env, BOT_TOKEN, chatId, session);
          return ok();
        }

        if (session.awaiting_filename) {
          session.filename = await applyCounterToName(env, chatId, text || session.default_name || "video");
          session.awaiting_filename = false;
          session.pending_confirmation = true;
          session.confirmation_message_id = null;
          await setSession(env, chatId, session);
          
          const confirmKeyboard = {
            inline_keyboard: [
              [
                { text: "✅ تأكيد", callback_data: "confirm_action" },
                { text: "🚫 إلغاء", callback_data: "cancel_action" }
              ]
            ]
          };
          
          const summary = buildSummaryMessage(session);
          const sentMsg = await sendMessageWithReturn(BOT_TOKEN, chatId, `📋 ملخص العملية:\n${summary}\n\nهل تريد تأكيد الإرسال؟`, confirmKeyboard);
          session.confirmation_message_id = sentMsg?.result?.message_id;
          await setSession(env, chatId, session);
          return ok();
        }

        await sendMessage(BOT_TOKEN, chatId, "📤 أرسل فيديو مباشرة أو أي رابط للبدء، أو استخدم /setup لحفظ إعداد تلقائي.");
        return ok();
      }

      // ضغطات الأزرار.
      if (update.callback_query) {
        const query = update.callback_query;
        const chatId = query.message.chat.id;
        const data = query.data;
        await answerCallback(BOT_TOKEN, query.id);

        const isAuthorized = await env.SESSIONS.get(`authorized:${chatId}`);
        if (!isAuthorized) return ok();

        const session = (await getSession(env, chatId)) || {};

        if (data === "confirm_action") {
          if (!session.pending_confirmation) {
            await editMessage(BOT_TOKEN, chatId, query.message.message_id, "⚠️ لا توجد عملية معلقة للتأكيد.");
            return ok();
          }
          
          session.pending_confirmation = false;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "✅ تم تأكيد العملية. جارٍ الإرسال...");
          await finalizeAndTrigger(
            env,
            BOT_TOKEN,
            GITHUB_TOKEN,
            GITHUB_REPO,
            GITHUB_WORKFLOW,
            chatId,
            session,
          );
          return ok();
        }

        if (data === "cancel_action") {
          if (!session.pending_confirmation) {
            await editMessage(BOT_TOKEN, chatId, query.message.message_id, "⚠️ لا توجد عملية معلقة للإلغاء.");
            return ok();
          }
          
          await deleteSession(env, chatId);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "🚫 تم إلغاء العملية.");
          return ok();
        }

        if (data === "cancel") {
          await deleteSession(env, chatId);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "🚫 تم إلغاء العملية.");
          return ok();
        }

        if (data.startsWith("codec_")) {
          const codec = data.split("_")[1];
          if (!["av1", "audio"].includes(codec)) return ok();

          session.codec = codec;
          if (codec === "audio") {
            session.encode_mode = "audio";
            session.filter_profile = "none";
            session.preset = "none";
            session.encode_method = "audio";
            session.awaiting_target_value = true;
            await setSession(env, chatId, session);
            await editMessage(BOT_TOKEN, chatId, query.message.message_id, "أرسل معدل بت الصوت، مثال: 32k أو 48k:");
          } else {
            await setSession(env, chatId, session);
            await editMessage(
              BOT_TOKEN,
              chatId,
              query.message.message_id,
              `🎞️ المرمّز المختار: AV1`,
            );
            await sendEncodeModeKeyboard(BOT_TOKEN, chatId);
          }
          return ok();
        }

        if (data.startsWith("mode_")) {
          const mode = data.split("_")[1];
          if (!["filters", "nofilters"].includes(mode)) return ok();

          session.encode_mode = mode;
          session.filter_profile = mode === "nofilters" ? "none" : undefined;
          await setSession(env, chatId, session);

          if (mode === "filters") {
            await editMessage(
              BOT_TOKEN,
              chatId,
              query.message.message_id,
              "🧩 اختر نوع الفلاتر: الأنمي للرسوم والمساحات اللونية، والواقعي للتصوير الحقيقي:",
              filterProfileKeyboardMarkup(),
            );
          } else {
            session.awaiting_preset = true;
            await setSession(env, chatId, session);
            await editMessage(BOT_TOKEN, chatId, query.message.message_id, presetPrompt(session.codec));
          }
          return ok();
        }

        if (data.startsWith("filter_")) {
          const profile = data.split("_")[1];
          if (!["anime", "realistic"].includes(profile)) return ok();

          session.filter_profile = profile;
          session.awaiting_preset = true;
          await setSession(env, chatId, session);
          await editMessage(
            BOT_TOKEN,
            chatId,
            query.message.message_id,
            `${profile === "anime" ? "🌸 تم اختيار فلاتر الأنمي." : "🎬 تم اختيار فلاتر المحتوى الواقعي."}\n${presetPrompt(session.codec)}`,
          );
          return ok();
        }

        if (data.startsWith("preset_")) {
          const presetValue = data.split("_")[1];
          if (!isValidPreset(session.codec || "av1", presetValue)) return ok();
          session.preset = presetValue;
          await setSession(env, chatId, session);
          await editMessage(
            BOT_TOKEN,
            chatId,
            query.message.message_id,
            `🏎️ تم تسجيل السرعة: ${presetValue}\n🎛️ اختر طريقة الضغط:`,
            encodeMethodKeyboardMarkup(session.codec || "av1"),
          );
          return ok();
        }

        if (data.startsWith("encmethod_")) {
          const method = data.split("_")[1];
          if (!isValidEncodeMethod(session.codec, method)) return ok();

          session.encode_method = method;
          session.awaiting_target_value = true;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, encodeMethodPrompt(session.codec, method));
          return ok();
        }

        if (data === "autoname_keep") {
          session.auto_naming = "source";
          delete session.series_title;
          delete session.next_episode;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "📄 سيحتفظ كل ملف باسمه المرفق تلقائياً.");
          await savePresetAndConfirm(env, BOT_TOKEN, chatId, session);
          return ok();
        }

        if (data === "autoname_series") {
          session.auto_naming = "series";
          session.awaiting_series_title = true;
          await setSession(env, chatId, session);
          await editMessage(
            BOT_TOKEN,
            chatId,
            query.message.message_id,
            "📝 أرسل اسم السلسلة كما تريد ظهوره.\nمثال: Solo Leveling S02\n\nسيكون الناتج: Solo Leveling S02 - E01\n\nللإلغاء أرسل /cancel",
          );
          return ok();
        }

        if (data === "custom_res") {
          session.awaiting_res = true;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "📐 أرسل الارتفاع المطلوب رقماً فقط، مثال: 550:\n\nللإلغاء أرسل /cancel");
          return ok();
        }

        if (data === "auto_res") {
          session.resolution = "auto";
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, "🎯 تم اختيار: نفس جودة الفيديو الأصلية");
          await continueAfterResolution(env, BOT_TOKEN, chatId, session);
          return ok();
        }

        if (data.startsWith("res_")) {
          const resolution = data.split("_")[1];
          if (!isValidResolution(resolution)) return ok();
          session.resolution = resolution;
          await setSession(env, chatId, session);
          await editMessage(BOT_TOKEN, chatId, query.message.message_id, `🎯 تم اختيار الدقة: ${resolution}p`);
          await continueAfterResolution(env, BOT_TOKEN, chatId, session);
          return ok();
        }

        if (data === "name_skip") {
          session.filename = await applyCounterToName(env, chatId, session.default_name || "video");
          session.awaiting_filename = false;
          session.pending_confirmation = true;
          session.confirmation_message_id = null;
          await setSession(env, chatId, session);
          
          const confirmKeyboard = {
            inline_keyboard: [
              [
                { text: "✅ تأكيد", callback_data: "confirm_action" },
                { text: "🚫 إلغاء", callback_data: "cancel_action" }
              ]
            ]
          };
          
          const summary = buildSummaryMessage(session);
          const sentMsg = await sendMessageWithReturn(BOT_TOKEN, chatId, `📋 ملخص العملية:\n${summary}\n\nهل تريد تأكيد الإرسال؟`, confirmKeyboard);
          session.confirmation_message_id = sentMsg?.result?.message_id;
          await setSession(env, chatId, session);
          return ok();
        }
      }
    } catch (error) {
      console.error("Worker handler error:", error?.message, error?.stack);
    }

    return ok();
  },
};

// دالة للتحقق من أي رابط
function isAnyLink(text) {
  // يقبل أي نص يبدأ بـ http:// أو https://
  return /^https?:\/\/\S+$/i.test(text);
}

// دالة لاستخراج معلومات الرابط
function extractLinkInfo(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '');
    
    // استخراج اسم الملف من الرابط
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1] || '';
    
    // التحقق من امتداد الفيديو
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts', '.mts', '.vob', '.3gp', '.3g2', '.ogv', '.mpeg', '.mpg', '.m3u8'];
    let filename = lastPart;
    
    if (videoExtensions.some(ext => lastPart.toLowerCase().includes(ext))) {
      // إزالة الامتداد
      filename = lastPart.replace(/\.[^/.]+$/, '');
    } else {
      // توليد اسم من الرابط
      filename = generateNameFromLink(hostname, parsed, pathParts);
    }
    
    return {
      name: cleanFileName(filename) || `video_${Date.now()}`,
      hostname: hostname,
      fullUrl: url
    };
  } catch {
    return {
      name: `video_${Date.now()}`,
      hostname: "unknown",
      fullUrl: url
    };
  }
}

// دالة لتوليد اسم من الرابط
function generateNameFromLink(hostname, parsed, pathParts) {
  const timestamp = Date.now();
  
  // استخراج أي معرف من الرابط
  const lastPath = pathParts[pathParts.length - 1] || '';
  const queryParams = parsed.searchParams.toString();
  
  // محاولة استخراج اسم ذو معنى
  if (lastPath && lastPath.length > 0 && lastPath.length < 100) {
    // تنظيف الاسم
    const cleanedName = cleanFileName(lastPath);
    if (cleanedName && cleanedName.length > 0) {
      return `${hostname}_${cleanedName}`;
    }
  }
  
  // إذا لم نجد اسم مناسب، نستخدم اسم المضيف والوقت
  return `${hostname}_${timestamp}`;
}

// دالة لبناء ملخص العملية
function buildSummaryMessage(session) {
  const codecLabel = session.codec === "audio" ? "صوت فقط" : "AV1";
  const modeLabel = session.encode_mode === "filters" 
    ? (session.filter_profile === "anime" ? "مع فلاتر الأنمي" : "مع فلاتر الواقعي")
    : session.encode_mode === "audio" ? "صوت فقط" : "بدون فلاتر";
  const methodLabel = session.encode_method === "crf" ? "CRF" 
    : session.encode_method === "twopass" ? "Two-Pass"
    : "استخراج صوت";
  const resolutionLabel = session.resolution === "auto" ? "نفس جودة الفيديو الأصلية" : `${session.resolution}p`;
  
  const lines = [
    `📁 اسم الملف: ${session.filename || "غير محدد"}`,
    `🎞️ المرمّز: ${codecLabel}`,
    `🖼️ الوضع: ${modeLabel}`,
    `🏎️ السرعة: ${session.preset || "-"}`,
    `🎛️ الطريقة: ${methodLabel}`,
    `📊 القيمة: ${session.target_value || "-"}`,
  ];
  
  if (session.codec !== "audio") {
    lines.push(`🎯 الدقة: ${resolutionLabel}`);
  }
  
  return lines.join("\n");
}

function ok() {
  return new Response("OK", { status: 200 });
}

async function getSession(env, chatId) {
  const raw = await env.SESSIONS.get(`session:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

async function setSession(env, chatId, session) {
  await env.SESSIONS.put(`session:${chatId}`, JSON.stringify(session), { expirationTtl: 3600 });
}

async function deleteSession(env, chatId) {
  await env.SESSIONS.delete(`session:${chatId}`);
}

async function getPreset(env, chatId) {
  const raw = await env.SESSIONS.get(`preset:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

async function setPreset(env, chatId, preset) {
  await env.SESSIONS.put(`preset:${chatId}`, JSON.stringify(preset));
}

async function applyCounterToName(_env, _chatId, baseName) {
  return cleanFileName(baseName) || "video";
}

function cleanFileName(value) {
  return String(value || "")
    .replace(/\.[^/.]+$/, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatEpisode(value) {
  return String(Number.parseInt(value, 10)).padStart(2, "0");
}

function buildAutomaticName(preset, sourceName) {
  if (
    preset?.auto_naming === "series" &&
    preset.series_title &&
    Number.isInteger(preset.next_episode) &&
    preset.next_episode > 0
  ) {
    return `${cleanFileName(preset.series_title)} - E${formatEpisode(preset.next_episode)}`;
  }
  return cleanFileName(sourceName) || "video";
}

async function continueAfterResolution(env, botToken, chatId, session) {
  if (session.configuring_preset) {
    await sendAutoNamingKeyboard(botToken, chatId);
    return;
  }

  session.awaiting_filename = true;
  await setSession(env, chatId, session);
  await promptFilename(botToken, chatId, null, session.default_name, false);
}

async function savePresetAndConfirm(env, botToken, chatId, session) {
  const oldPreset = await getPreset(env, chatId);
  const preset = {
    codec: session.codec || "av1",
    encode_mode: session.encode_mode || "nofilters",
    filter_profile:
      session.filter_profile || (session.encode_mode === "filters" ? "realistic" : "none"),
    preset: session.preset || "8",
    encode_method: session.encode_method || "crf",
    target_value: session.target_value || "28",
    resolution: session.resolution || "480",
    auto_naming: session.auto_naming || "source",
    active: true,
  };

  if (session.auto_naming === "series") {
    preset.series_title = cleanFileName(session.series_title);
    preset.next_episode = Number.parseInt(session.next_episode, 10);
  }

  await setPreset(env, chatId, preset);
  await deleteSession(env, chatId);
  await sendMessage(botToken, chatId, `✅ تم حفظ الإعداد وتفعيل الوضع التلقائي.\n${presetStatusText(preset)}\n⏸️ استخدم /auto_off لإيقافه.`);
}

function presetStatusText(preset) {
  if (!preset) return "لا يوجد إعداد محفوظ.";

  const codecLabel = preset.codec === "audio" ? "صوت فقط" : "AV1";
  const modeLabel =
    preset.encode_mode === "filters"
      ? preset.filter_profile === "anime"
        ? "مع فلاتر الأنمي"
        : "مع فلاتر الواقعي"
      : preset.encode_mode === "audio"
        ? "صوت فقط"
        : "بدون فلاتر";
  const methodLabel =
    preset.encode_method === "crf"
      ? "CRF"
      : preset.encode_method === "twopass"
        ? "Two-Pass"
        : "استخراج صوت";
  const resolutionLabel = preset.resolution === "auto" ? "نفس جودة الفيديو الأصلية" : `${preset.resolution}p`;

  const lines = [
    `المرمّز: ${codecLabel}`,
    `الوضع: ${modeLabel}`,
    `السرعة: ${preset.preset || "-"}`,
    `الطريقة: ${methodLabel}`,
    `القيمة: ${preset.target_value}`,
  ];
  if (preset.codec !== "audio") lines.push(`الدقة: ${resolutionLabel}`);
  if (preset.auto_naming === "series" && preset.series_title && preset.next_episode) {
    lines.push(`التسمية: ${preset.series_title} - E${formatEpisode(preset.next_episode)}`);
  } else {
    lines.push("التسمية: الاحتفاظ باسم الفيديو المرفق");
  }
  return lines.join("\n");
}

function startMessage(preset) {
  return [
    "🚀 أرسل فيديو مباشرة أو أي رابط للبدء.",
    "",
    "📎 يمكنك إرسال:",
    "- فيديو مباشر من جهازك",
    "- أي رابط فيديو (يوتيوب، تيليجرام، Google Drive، وغيرها)",
    "- أي رابط مباشر",
    "",
    "الأوامر:",
    "/setup لحفظ إعداد تلقائي",
    "/preset لعرض الإعداد المحفوظ",
    "/auto_on و /auto_off لتشغيل أو إيقاف الوضع التلقائي",
    "/cancel لإلغاء أي عملية جارية",
    "",
    "🎯 خيارات الدقة تشمل:",
    "- دقة ثابتة (240p إلى 1080p)",
    "- دقة مخصصة",
    "- نفس جودة الفيديو الأصلية (auto)",
    preset?.active ? "" : null,
    preset?.active ? "▶️ الوضع التلقائي مفعّل حالياً." : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function isValidPreset(codec, value) {
  if (codec === "av1") return /^(?:[0-9]|1[0-3])$/.test(value);
  return codec === "audio";
}

function isValidEncodeMethod(codec, method) {
  if (codec === "av1") return ["crf", "twopass"].includes(method);
  if (codec === "audio") return method === "audio";
  return false;
}

function isValidTargetValue(codec, method, value) {
  if (codec === "audio" || method === "twopass") {
    return /^[1-9]\d{0,5}(?:[kKmM])?$/.test(value);
  }
  if (codec === "av1" && method === "crf") {
    return /^(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(value);
  }
  return false;
}

function isValidResolution(value) {
  if (!/^\d{3,4}$/.test(value)) return false;
  const height = Number.parseInt(value, 10);
  return height >= 144 && height <= 2160;
}

function presetPrompt(codec) {
  return "أرسل رقم سرعة AV1 من 0 إلى 13، مثل 4 أو 8.";
}

function targetValueHint(codec, method) {
  if (codec === "audio") return "أرسل معدل بت صحيحاً، مثل 32k أو 48k.";
  if (codec === "av1" && method === "crf") return "أرسل قيمة CRF من 0 إلى 63، مثل 28 أو 35.";
  return "أرسل معدل بت صحيحاً، مثل 250k أو 1000k.";
}

function encodeMethodPrompt(codec, method) {
  if (codec === "av1" && method === "crf") {
    return "تم اختيار CRF. أرسل قيمة CRF من 0 إلى 63، مثل 28 أو 35:";
  }
  if (codec === "av1" && method === "twopass") {
    return "تم اختيار Two-Pass. أرسل معدل البت المستهدف، مثل 250k أو 1000k:";
  }
  return "أرسل معدل البت المستهدف، مثل 250k أو 1000k:";
}

async function triggerGitHub(githubToken, githubRepo, githubWorkflow, session, chatId) {
  const body = {
    ref: "main",
    inputs: {
      message_id: session.message_id ? String(session.message_id) : "",
      url: session.url || "",
      chat_id: String(chatId),
      filename: session.filename || "video",
      codec: session.codec || "av1",
      preset: session.preset || "8",
      encode_mode: session.encode_mode || "nofilters",
      filter_profile:
        session.filter_profile || (session.encode_mode === "filters" ? "realistic" : "none"),
      encode_method: session.encode_method || "crf",
      target_value: String(session.target_value || "28"),
      resolution: session.resolution || "480",
      frame_rate: "24",
    },
  };

  const response = await fetch(
    `https://api.github.com/repos/${githubRepo}/actions/workflows/${githubWorkflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Cloudflare-Worker",
      },
      body: JSON.stringify(body),
    },
  );

  const responseText = await response.text();
  if (!response.ok) {
    console.error("GitHub workflow dispatch failed:", {
      status: response.status,
      repository: githubRepo,
      workflow: githubWorkflow,
      detail: responseText.slice(0, 1500),
    });
    return false;
  }

  console.log("GitHub workflow dispatched:", {
    status: response.status,
    repository: githubRepo,
    workflow: githubWorkflow,
  });
  return true;
}

async function finalizeAndTrigger(env, botToken, githubToken, githubRepo, githubWorkflow, chatId, session) {
  const success = await triggerGitHub(githubToken, githubRepo, githubWorkflow, session, chatId);
  if (success) {
    if (session.auto_advance_episode) {
      const preset = await getPreset(env, chatId);
      if (preset?.auto_naming === "series" && Number.isInteger(preset.next_episode)) {
        preset.next_episode += 1;
        await setPreset(env, chatId, preset);
      }
    }
    await sendMessage(botToken, chatId, "✅ تم إرسال المهمة إلى مصنع الضغط السحابي.");
  } else {
    await sendMessage(botToken, chatId, "❌ فشل إرسال المهمة إلى GitHub. تحقق من سجل العامل ورمز GitHub." );
  }
  await deleteSession(env, chatId);
}

function extractDefaultName(message) {
  const name = message.caption || message.document?.file_name || message.video?.file_name || null;
  if (!name) return null;
  return name.replace(/\.[^/.]+$/, "").replace(/[\\/:*?"<>|]/g, " ").trim();
}

async function promptFilename(botToken, chatId, editMessageId, defaultName, useEdit) {
  const text = defaultName
    ? `الاسم المرفق: ${defaultName}\n\nأرسل اسماً جديداً، أو اضغط «✅ استخدام الاسم المرفق».`
    : "أرسل الاسم النهائي للملف:";
  const keyboard = defaultName
    ? { 
        inline_keyboard: [
          [{ text: "✅ استخدام الاسم المرفق", callback_data: "name_skip" }],
          [{ text: "🚫 إلغاء", callback_data: "cancel" }]
        ] 
      }
    : { 
        inline_keyboard: [
          [{ text: "🚫 إلغاء", callback_data: "cancel" }]
        ] 
      };

  if (useEdit && editMessageId) {
    await editMessage(botToken, chatId, editMessageId, text, keyboard);
  } else {
    await sendMessage(botToken, chatId, text, keyboard);
  }
}

async function sendCodecKeyboard(botToken, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "⚡ AV1", callback_data: "codec_av1" }],
      [{ text: "🎵 صوت فقط", callback_data: "codec_audio" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
  await sendMessage(botToken, chatId, "⚙️ اختر المرمّز أو استخراج الصوت:", keyboard);
}

async function sendEncodeModeKeyboard(botToken, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "🛠️ مع فلاتر", callback_data: "mode_filters" }],
      [{ text: "✨ بدون فلاتر", callback_data: "mode_nofilters" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
  await sendMessage(botToken, chatId, "🖼️ اختر وضع الصورة:", keyboard);
}

function filterProfileKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🌸 أنمي", callback_data: "filter_anime" }],
      [{ text: "🎬 محتوى واقعي", callback_data: "filter_realistic" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
}

async function sendEncodeMethodKeyboard(botToken, chatId, codec) {
  await sendMessage(botToken, chatId, "🎛️ اختر طريقة ترميز AV1:", encodeMethodKeyboardMarkup(codec));
}

function encodeMethodKeyboardMarkup(codec) {
  return {
    inline_keyboard: [
      [{ text: "🎚️ ضغط ذكي (CRF)", callback_data: "encmethod_crf" }],
      [{ text: "⚖️ حجم مضبوط (Two-Pass)", callback_data: "encmethod_twopass" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
}

async function sendAutoNamingKeyboard(botToken, chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "📄 الاحتفاظ باسم كل فيديو", callback_data: "autoname_keep" }],
      [{ text: "📺 اسم مسلسل + عداد حلقات", callback_data: "autoname_series" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
  await sendMessage(
    botToken,
    chatId,
    "🏷️ اختر التسمية التلقائية للوضع التلقائي:\n\n📄 الاحتفاظ بالاسم: يستعمل اسم الفيديو المرفق.\n📺 مسلسل: تسمي كل نتيجة مثل: اسم السلسلة - E01 ثم E02.",
    keyboard,
  );
}

async function sendQualityKeyboard(botToken, chatId, resolutions) {
  const rows = [];
  for (let index = 0; index < resolutions.length; index += 2) {
    rows.push(
      resolutions.slice(index, index + 2).map((resolution) => ({
        text: `${resolution}p`,
        callback_data: `res_${resolution}`,
      })),
    );
  }
  rows.push([{ text: "✏️ دقة مخصصة", callback_data: "custom_res" }]);
  rows.push([{ text: "🔄 نفس جودة الفيديو الأصلية", callback_data: "auto_res" }]);
  rows.push([{ text: "🚫 إلغاء", callback_data: "cancel" }]);
  await sendMessage(botToken, chatId, "🎯 اختر الدقة النهائية:", { inline_keyboard: rows });
}

async function sendTelegram(botToken, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error(`Telegram ${method} failed:`, response.status, await response.text());
  }
  return response.json();
}

async function sendMessage(botToken, chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = keyboard;
  await sendTelegram(botToken, "sendMessage", body);
}

async function sendMessageWithReturn(botToken, chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = keyboard;
  return await sendTelegram(botToken, "sendMessage", body);
}

async function editMessage(botToken, chatId, messageId, text, keyboard = null) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (keyboard) body.reply_markup = keyboard;
  await sendTelegram(botToken, "editMessageText", body);
}

async function answerCallback(botToken, callbackQueryId) {
  await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: callbackQueryId });
          }
