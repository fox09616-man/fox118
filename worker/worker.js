// ============================================================================
// بوت تيليجرام لضغط الفيديو (Cloudflare Worker) ← يشغّل GitHub Actions
//
// المتغيرات المطلوبة (Secrets):  BOT_TOKEN, GITHUB_TOKEN, BOT_PASSWORD
// ربط KV مطلوب:                   SESSIONS
// اختيارية:
//   WEBHOOK_SECRET   إن وُجد يُرفض أي طلب لا يحمل نفس القيمة في الترويسة
//                    X-Telegram-Bot-Api-Secret-Token (استعمل secret_token في setWebhook)
//   GITHUB_REPO      "owner/repo"   (الافتراضي: fox09616-man/fox118)
//   GITHUB_WORKFLOW  اسم ملف الـ workflow (الافتراضي: compress.yml)
//   GITHUB_REF       الفرع (الافتراضي: main)
// ============================================================================

const DEFAULT_REPO = "fox09616-man/fox118";
const DEFAULT_WORKFLOW = "compress.yml";
const DEFAULT_REF = "main";
const RESOLUTIONS = ["240", "360", "480", "720", "1080"];

const MAX_AUTH_FAILURES = 5;
const AUTH_LOCK_SECONDS = 900;
const SESSION_TTL_SECONDS = 3600;
const MAX_NAME_LENGTH = 120;

// ============================================================================
// خيارات الفلاتر — يجب أن تطابق workflow_dispatch inputs في compress.yml
// ============================================================================
const DENOISE_FILTERS = ["off", "hqdn3d", "atadenoise", "hqdn3d+atadenoise", "nlmeans"];
const DENOISE_STRENGTHS = ["light", "medium", "strong"];
const DEBAND_FILTERS = ["off", "deband", "gradfun", "deband+gradfun"];
const BRIGHTNESS_CURVES = ["off", "eq", "curves-light", "curves-medium", "curves-strong"];
const SATURATION_BOOSTS = ["off", "eq", "colorbalance"];
const SHARPEN_FILTERS = ["off", "cas", "unsharp"];

// الافتراضيات للأنمي
const FILTER_DEFAULTS = {
  denoise_filter: "hqdn3d+atadenoise",
  denoise_strength: "medium",
  deband_filter: "gradfun",
  brightness_curve: "curves-medium",
  saturation_boost: "colorbalance",
  sharpen_filter: "cas",
  custom_denoise: "",
  custom_deband: "",
  custom_brightness: "",
  custom_saturation: "",
  custom_sharpen: "",
};

// القيم المسموحة للفلاتر المخصصة (تسمح بـ = : ' " / + - . _ والأرقام والمسافات داخل الاقتباسات)
const CUSTOM_FILTER_RE = /^[a-zA-Z][a-zA-Z0-9_]*=.+$/;

// امتدادات الوسائط فقط. لا نحذف أي "امتداد" عشوائي حتى لا نخسر أجزاء من الاسم
// مثل ".E01" في "Show S02.E01" أو ".0" في "Movie 2.0".
const MEDIA_EXT_RE =
  /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mts|vob|3gp|3g2|ogv|mpeg|mpg|m3u8|mp3|m4a|aac|opus|ogg|wav|flac)$/i;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!safeEqual(got, env.WEBHOOK_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    const cfg = {
      botToken: env.BOT_TOKEN,
      githubToken: env.GITHUB_TOKEN,
      repo: env.GITHUB_REPO || DEFAULT_REPO,
      workflow: env.GITHUB_WORKFLOW || DEFAULT_WORKFLOW,
      ref: env.GITHUB_REF || DEFAULT_REF,
    };

    let errorChatId = null;
    try {
      const update = await request.json();
      errorChatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id ?? null;

      if (update.message && isVideoMessage(update.message)) {
        await handleVideo(env, cfg, update.message);
      } else if (update.message && update.message.text !== undefined) {
        await handleText(env, cfg, update.message);
      } else if (update.callback_query) {
        await handleCallback(env, cfg, update.callback_query);
      }
    } catch (error) {
      console.error("Worker handler error:", error?.message, error?.stack);
      if (errorChatId !== null) {
        try {
          await sendMessage(cfg.botToken, errorChatId, "⚠️ حدث خطأ داخلي غير متوقع. حاول مرة أخرى، وإن تكرر أرسل /cancel ثم ابدأ من جديد.");
        } catch {
          // لا شيء
        }
      }
    }

    return ok();
  },
};

// ---------------------------------------------------------------------------
// المعالجات الرئيسية
// ---------------------------------------------------------------------------

function isVideoMessage(message) {
  return Boolean(
    message.video ||
      (message.document && (message.document.mime_type || "").startsWith("video/")),
  );
}

async function isAuthorized(env, chatId) {
  return Boolean(await env.SESSIONS.get(`authorized:${chatId}`));
}

function isSetupBusy(session) {
  return Boolean(
    session.configuring_preset ||
      session.awaiting_preset ||
      session.awaiting_target_value ||
      session.awaiting_res ||
      session.awaiting_filename ||
      session.awaiting_series_title ||
      session.awaiting_episode_start ||
      session.awaiting_custom_filter_text ||
      session.pending_confirmation,
  );
}

function hasActiveSession(session) {
  return Object.keys(session).length > 0;
}

const BUSY_MESSAGE = "⚠️ أنت في منتصف عملية إعداد. أكمل الإعداد أولاً أو ألغِ العملية بـ /cancel.";

async function handleVideo(env, cfg, message) {
  const chatId = message.chat.id;

  if (!(await isAuthorized(env, chatId))) {
    await sendMessage(cfg.botToken, chatId, "🔒 هذا البوت خاص. أرسل كلمة المرور للمتابعة:");
    return;
  }

  const session = (await getSession(env, chatId)) || {};
  if (isSetupBusy(session)) {
    await sendMessage(cfg.botToken, chatId, BUSY_MESSAGE);
    return;
  }

  const defaultName = extractDefaultName(message);
  const preset = await getPreset(env, chatId);

  if (preset && preset.active) {
    await runAutomatic(
      env,
      cfg,
      chatId,
      preset,
      { message_id: message.message_id, url: "" },
      defaultName,
      "📤 جارٍ إرسال المهمة تلقائياً",
    );
    return;
  }

  await setSession(env, chatId, {
    message_id: message.message_id,
    url: "",
    default_name: defaultName,
    pending_confirmation: false,
  });
  await sendCodecKeyboard(cfg.botToken, chatId);
}

async function handleText(env, cfg, message) {
  const chatId = message.chat.id;
  const rawText = message.text.trim();

  if (!(await isAuthorized(env, chatId))) {
    await handleUnauthorizedText(env, cfg, message, rawText);
    return;
  }

  const text = rawText.replace(/^(\/[A-Za-z0-9_]+)@\w+/, "$1");
  const session = (await getSession(env, chatId)) || {};

  if (isAnyLink(text)) {
    if (isSetupBusy(session)) {
      await sendMessage(cfg.botToken, chatId, BUSY_MESSAGE);
      return;
    }

    const preset = await getPreset(env, chatId);
    const linkInfo = extractLinkInfo(text);

    if (preset && preset.active) {
      await runAutomatic(
        env,
        cfg,
        chatId,
        preset,
        { message_id: "", url: text },
        linkInfo.name || "video",
        "📤 جارٍ معالجة الرابط تلقائياً",
      );
    } else {
      await setSession(env, chatId, {
        message_id: "",
        url: text,
        default_name: linkInfo.name,
        pending_confirmation: false,
      });
      await sendCodecKeyboard(cfg.botToken, chatId);
    }
    return;
  }

  if (session.pending_confirmation) {
    if (text === "/confirm" || text === "✅ تأكيد") {
      await confirmAndSend(env, cfg, chatId, session, null);
    } else if (text === "/cancel" || text === "🚫 إلغاء") {
      await deleteSession(env, chatId);
      await sendMessage(cfg.botToken, chatId, "🚫 تم إلغاء العملية.");
    } else {
      await sendMessage(cfg.botToken, chatId, "⚠️ الرجاء اختيار تأكيد أو إلغاء العملية:");
    }
    return;
  }

  if (text === "/start") {
    await sendMessage(cfg.botToken, chatId, startMessage(await getPreset(env, chatId)));
    return;
  }

  if (text === "/setup" || text === "/settings") {
    await setSession(env, chatId, { configuring_preset: true, pending_confirmation: false });
    await sendCodecKeyboard(cfg.botToken, chatId);
    return;
  }

  if (text === "/preset") {
    await sendMessage(cfg.botToken, chatId, presetStatusText(await getPreset(env, chatId)));
    return;
  }

  if (text === "/auto_off") {
    const preset = await getPreset(env, chatId);
    if (!preset) {
      await sendMessage(cfg.botToken, chatId, "لا يوجد إعداد محفوظ أصلاً.");
    } else {
      preset.active = false;
      await setPreset(env, chatId, preset);
      await sendMessage(cfg.botToken, chatId, "⏸️ تم إيقاف الوضع التلقائي. أرسل فيديو وستُسأل عن الإعدادات.");
    }
    return;
  }

  if (text === "/auto_on") {
    const preset = await getPreset(env, chatId);
    if (!preset) {
      await sendMessage(cfg.botToken, chatId, "لا يوجد إعداد محفوظ. استخدم /setup أولاً.");
    } else {
      preset.active = true;
      await setPreset(env, chatId, preset);
      await sendMessage(cfg.botToken, chatId, `▶️ تم تفعيل الوضع التلقائي.\n${presetStatusText(preset)}`);
    }
    return;
  }

  if (text === "/cancel") {
    await deleteSession(env, chatId);
    await sendMessage(cfg.botToken, chatId, "🚫 تم إلغاء العملية.");
    return;
  }

  // ============ مدخلات الفلتر المخصص ============
  if (session.awaiting_custom_filter_text) {
    const field = session.awaiting_custom_filter_text;
    const value = String(text).trim();

    if (value === "حذف" || value.toLowerCase() === "delete" || value === "-") {
      session[field] = "";
      session.awaiting_custom_filter_text = null;
      await setSession(env, chatId, session);
      await sendMessage(
        cfg.botToken,
        chatId,
        `✅ تم حذف ${field}`,
        customFiltersKeyboardMarkup(session),
      );
      return;
    }

    if (!CUSTOM_FILTER_RE.test(value)) {
      await sendMessage(
        cfg.botToken,
        chatId,
        "⚠️ صيغة غير صحيحة. يجب أن تبدأ باسم الفلتر ثم =\n" +
          "أمثلة صحيحة:\n" +
          "• gradfun=strength=2.0:radius=20\n" +
          "• eq=brightness=0.08\n" +
          "• curves=all='0/0 0.2/0.30 1/1'\n" +
          "• unsharp=luma_msize_x=5:luma_amount=0.5\n\n" +
          "للإلغاء أرسل /cancel",
      );
      return;
    }

    session[field] = value;
    session.awaiting_custom_filter_text = null;
    await setSession(env, chatId, session);

    await sendMessage(
      cfg.botToken,
      chatId,
      `✅ تم حفظ ${field}: ${value}`,
      customFiltersKeyboardMarkup(session),
    );
    return;
  }

  // ============ مدخلات الإعداد النصية ============
  if (session.awaiting_series_title) {
    const seriesTitle = cleanFileName(text);
    if (!seriesTitle) {
      await sendMessage(cfg.botToken, chatId, "📝 أرسل اسماً صحيحاً للمسلسل، مثل: Solo Leveling S02\n\nللإلغاء أرسل /cancel");
      return;
    }
    session.series_title = seriesTitle;
    session.awaiting_series_title = false;
    session.awaiting_episode_start = true;
    await setSession(env, chatId, session);
    await sendMessage(cfg.botToken, chatId, `✅ اسم السلسلة: ${seriesTitle}\n🔢 أرسل رقم الحلقة الأولى، مثل: 1\n\nللإلغاء أرسل /cancel`);
    return;
  }

  if (session.awaiting_episode_start) {
    if (!/^[1-9]\d{0,5}$/.test(text)) {
      await sendMessage(cfg.botToken, chatId, "🔢 أرسل رقم حلقة موجباً فقط، مثل: 1 أو 12.\n\nللإلغاء أرسل /cancel");
      return;
    }
    session.next_episode = Number.parseInt(text, 10);
    session.awaiting_episode_start = false;
    await setSession(env, chatId, session);
    await savePresetAndConfirm(env, cfg.botToken, chatId, session);
    return;
  }

  if (session.awaiting_preset) {
    const codec = session.codec || "av1";
    if (!isValidPreset(codec, text)) {
      await sendMessage(cfg.botToken, chatId, "أرسل رقم سرعة AV1 من 0 إلى 13 فقط:\n\nللإلغاء أرسل /cancel");
      return;
    }

    session.preset = text;
    session.awaiting_preset = false;
    await setSession(env, chatId, session);
    await sendMessage(cfg.botToken, chatId, `✅ تم تسجيل AV1 preset: ${text}`);
    await sendEncodeMethodKeyboard(cfg.botToken, chatId, codec);
    return;
  }

  if (session.awaiting_target_value) {
    const value = normalizeTargetValue(session.codec, session.encode_method, text);
    if (value === null) {
      await sendMessage(cfg.botToken, chatId, targetValueHint(session.codec, session.encode_method) + "\n\nللإلغاء أرسل /cancel");
      return;
    }

    session.target_value = value;
    session.awaiting_target_value = false;
    await setSession(env, chatId, session);

    if (session.codec === "audio") {
      if (session.configuring_preset) {
        await sendAutoNamingKeyboard(cfg.botToken, chatId);
      } else {
        session.awaiting_filename = true;
        await setSession(env, chatId, session);
        await promptFilename(cfg.botToken, chatId, null, session.default_name, false);
      }
    } else {
      await sendMessage(cfg.botToken, chatId, `✅ تم تسجيل القيمة: ${value}`);
      await sendQualityKeyboard(cfg.botToken, chatId, RESOLUTIONS);
    }
    return;
  }

  if (session.awaiting_res) {
    if (!isValidResolution(text)) {
      await sendMessage(cfg.botToken, chatId, "أرسل ارتفاعاً صحيحاً بين 144 و2160، مثل 550:\n\nللإلغاء أرسل /cancel");
      return;
    }
    session.resolution = String(Number.parseInt(text, 10));
    session.awaiting_res = false;
    await setSession(env, chatId, session);
    await continueAfterResolution(env, cfg.botToken, chatId, session);
    return;
  }

  if (session.awaiting_filename) {
    session.filename = cleanFileName(text) || cleanFileName(session.default_name) || "video";
    await askConfirmation(env, cfg, chatId, session);
    return;
  }

  await sendMessage(cfg.botToken, chatId, "📤 أرسل فيديو مباشرة أو أي رابط للبدء، أو استخدم /setup لحفظ إعداد تلقائي.");
}

async function handleUnauthorizedText(env, cfg, message, rawText) {
  const chatId = message.chat.id;
  const prompt = "🔒 هذا البوت خاص. أرسل كلمة المرور للمتابعة:";

  if (rawText.startsWith("/")) {
    await sendMessage(cfg.botToken, chatId, prompt);
    return;
  }

  const lockKey = `authfail:${chatId}`;
  const failures = Number.parseInt((await env.SESSIONS.get(lockKey)) || "0", 10) || 0;
  if (failures >= MAX_AUTH_FAILURES) {
    await sendMessage(cfg.botToken, chatId, "⛔ محاولات كثيرة خاطئة. حاول مجدداً بعد 15 دقيقة.");
    return;
  }

  if (env.BOT_PASSWORD && safeEqual(rawText, env.BOT_PASSWORD)) {
    await env.SESSIONS.put(`authorized:${chatId}`, "true");
    await env.SESSIONS.delete(lockKey);
    await deleteMessage(cfg.botToken, chatId, message.message_id);
    await sendMessage(cfg.botToken, chatId, "✅ تم التحقق بنجاح. أرسل /start للبدء.");
    return;
  }

  await env.SESSIONS.put(lockKey, String(failures + 1), { expirationTtl: AUTH_LOCK_SECONDS });
  await deleteMessage(cfg.botToken, chatId, message.message_id);
  await sendMessage(cfg.botToken, chatId, prompt);
}

async function handleCallback(env, cfg, query) {
  const message = query.message;
  await answerCallback(cfg.botToken, query.id);
  if (!message) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;
  const data = query.data || "";

  if (!(await isAuthorized(env, chatId))) return;

  const session = (await getSession(env, chatId)) || {};

  if (data === "confirm_action") {
    if (!session.pending_confirmation) {
      await editMessage(cfg.botToken, chatId, messageId, "⚠️ لا توجد عملية معلقة للتأكيد.");
      return;
    }
    await confirmAndSend(env, cfg, chatId, session, messageId);
    return;
  }

  if (data === "cancel_action") {
    if (!session.pending_confirmation) {
      await editMessage(cfg.botToken, chatId, messageId, "⚠️ لا توجد عملية معلقة للإلغاء.");
      return;
    }
    await deleteSession(env, chatId);
    await editMessage(cfg.botToken, chatId, messageId, "🚫 تم إلغاء العملية.");
    return;
  }

  if (data === "cancel") {
    await deleteSession(env, chatId);
    await editMessage(cfg.botToken, chatId, messageId, "🚫 تم إلغاء العملية.");
    return;
  }

  if (!hasActiveSession(session)) {
    await editMessage(cfg.botToken, chatId, messageId, "⌛ انتهت صلاحية هذه العملية. أرسل الفيديو أو الرابط من جديد.");
    return;
  }

  // ============ المرمّز ============
  if (data.startsWith("codec_")) {
    const codec = data.split("_")[1];
    if (!["av1", "audio"].includes(codec)) return;

    session.codec = codec;
    if (codec === "audio") {
      session.encode_mode = "audio";
      session.preset = "none";
      session.encode_method = "audio";
      session.awaiting_target_value = true;
      await setSession(env, chatId, session);
      await editMessage(cfg.botToken, chatId, messageId, "أرسل معدل بت الصوت (من 6k إلى 510k)، مثال: 32k أو 48k:");
    } else {
      await setSession(env, chatId, session);
      await editMessage(cfg.botToken, chatId, messageId, "🎞️ المرمّز المختار: AV1");
      await sendEncodeModeKeyboard(cfg.botToken, chatId);
    }
    return;
  }

  // ============ وضع الصورة ============
  if (data.startsWith("mode_")) {
    const mode = data.split("_")[1];
    if (!["filters", "nofilters"].includes(mode)) return;

    session.encode_mode = mode;
    await setSession(env, chatId, session);

    if (mode === "filters") {
      await editMessage(
        cfg.botToken,
        chatId,
        messageId,
        denoisePrompt(),
        denoiseFilterKeyboardMarkup(),
      );
    } else {
      // بدون فلاتر: تعيين الكل إلى off
      Object.assign(session, {
        denoise_filter: "off",
        denoise_strength: "medium",
        deband_filter: "off",
        brightness_curve: "off",
        saturation_boost: "off",
        sharpen_filter: "off",
        custom_denoise: "",
        custom_deband: "",
        custom_brightness: "",
        custom_saturation: "",
        custom_sharpen: "",
        awaiting_preset: true,
      });
      await setSession(env, chatId, session);
      await editMessage(cfg.botToken, chatId, messageId, presetPrompt());
    }
    return;
  }

  // ============ التنعيم ============
  if (data.startsWith("denoise_")) {
    const filter = data.slice("denoise_".length);
    if (!DENOISE_FILTERS.includes(filter)) return;
    session.denoise_filter = filter;
    await setSession(env, chatId, session);

    if (filter === "off") {
      session.denoise_strength = "medium";
      await setSession(env, chatId, session);
      await editMessage(
        cfg.botToken,
        chatId,
        messageId,
        "✅ تم تعطيل التنعيم.\n\n" + debandPrompt(),
        debandFilterKeyboardMarkup(),
      );
    } else {
      await editMessage(
        cfg.botToken,
        chatId,
        messageId,
        `✅ التنعيم: ${filter}\n\n${denoiseStrengthPrompt()}`,
        denoiseStrengthKeyboardMarkup(),
      );
    }
    return;
  }

  // ============ شدة التنعيم ============
  if (data.startsWith("dstrength_")) {
    const strength = data.slice("dstrength_".length);
    if (!DENOISE_STRENGTHS.includes(strength)) return;
    session.denoise_strength = strength;
    await setSession(env, chatId, session);
    await editMessage(
      cfg.botToken,
      chatId,
      messageId,
      `✅ الشدة: ${strength}\n\n${debandPrompt()}`,
      debandFilterKeyboardMarkup(),
    );
    return;
  }

  // ============ البانديج ============
  if (data.startsWith("deband_")) {
    const filter = data.slice("deband_".length);
    if (!DEBAND_FILTERS.includes(filter)) return;
    session.deband_filter = filter;
    await setSession(env, chatId, session);
    await editMessage(
      cfg.botToken,
      chatId,
      messageId,
      `✅ البانديج: ${filter}\n\n${brightnessPrompt()}`,
      brightnessKeyboardMarkup(),
    );
    return;
  }

  // ============ السطوع ============
  if (data.startsWith("bright_")) {
    const curve = data.slice("bright_".length);
    if (!BRIGHTNESS_CURVES.includes(curve)) return;
    session.brightness_curve = curve;
    await setSession(env, chatId, session);
    await editMessage(
      cfg.botToken,
      chatId,
      messageId,
      `✅ السطوع: ${curve}\n\n${saturationPrompt()}`,
      saturationKeyboardMarkup(),
    );
    return;
  }

  // ============ التشبع ============
  if (data.startsWith("sat_")) {
    const boost = data.slice("sat_".length);
    if (!SATURATION_BOOSTS.includes(boost)) return;
    session.saturation_boost = boost;
    await setSession(env, chatId, session);
    await editMessage(
      cfg.botToken,
      chatId,
      messageId,
      `✅ التشبع: ${boost}\n\n${sharpenPrompt()}`,
      sharpenKeyboardMarkup(),
    );
    return;
  }

  // ============ الحدة ============
  if (data.startsWith("sharp_")) {
    const filter = data.slice("sharp_".length);
    if (!SHARPEN_FILTERS.includes(filter)) return;
    session.sharpen_filter = filter;
    await setSession(env, chatId, session);
    await editMessage(
      cfg.botToken,
      chatId,
      messageId,
      `✅ الحدة: ${filter}\n\n${customFiltersPrompt()}`,
      customFiltersKeyboardMarkup(session),
    );
    return;
  }

  // ============ الفلاتر المخصصة ============
  if (data === "custom_skip") {
    Object.assign(session, {
      custom_denoise: "",
      custom_deband: "",
      custom_brightness: "",
      custom_saturation: "",
      custom_sharpen: "",
    });
    await setSession(env, chatId, session);

    if (session.configuring_preset) {
      await editMessage(cfg.botToken, chatId, messageId, "✅ تم تخطي الفلاتر المخصصة.");
      await sendAutoNamingKeyboard(cfg.botToken, chatId);
    } else {
      session.awaiting_filename = true;
      await setSession(env, chatId, session);
      await promptFilename(cfg.botToken, chatId, messageId, session.default_name, true);
    }
    return;
  }

  if (data === "custom_done") {
    if (session.configuring_preset) {
      await sendAutoNamingKeyboard(cfg.botToken, chatId);
    } else {
      session.awaiting_filename = true;
      await setSession(env, chatId, session);
      await promptFilename(cfg.botToken, chatId, messageId, session.default_name, true);
    }
    return;
  }

  if (data.startsWith("custom_edit_")) {
    const field = data.slice("custom_edit_".length);
    const allowed = ["denoise", "deband", "brightness", "saturation", "sharpen"];
    if (!allowed.includes(field)) return;
    session.awaiting_custom_filter_text = `custom_${field}`;
    await setSession(env, chatId, session);
    await editMessage(
      cfg.botToken,
      chatId,
      messageId,
      customFilterHint(field),
      cancelOnlyKeyboardMarkup(),
    );
    return;
  }

  // ============ طريقة الترميز ============
  if (data.startsWith("encmethod_")) {
    const method = data.split("_")[1];
    if (!isValidEncodeMethod(session.codec, method)) return;

    session.encode_method = method;
    if (method === "auto") {
      session.target_value = "85";
      session.awaiting_target_value = false;
      await setSession(env, chatId, session);
      await editMessage(
        cfg.botToken,
        chatId,
        messageId,
        "🎯 جودة تلقائية موزّعة حسب المشهد (Av1an Target Quality): يقسّم Av1an الجزء إلى مشاهد، يقيس VMAF لكل مشهد، ويختار CRF الذي يبلغ الدرجة المستهدفة بأصغر حجم.\nالافتراضي: VMAF 85.",
        {
          inline_keyboard: [
            [{ text: "✅ متابعة (VMAF 85)", callback_data: "autoref_ok" }],
            [{ text: "✏️ درجة VMAF أخرى", callback_data: "autoref_custom" }],
            [{ text: "🚫 إلغاء", callback_data: "cancel" }],
          ],
        },
      );
      return;
    }
    session.awaiting_target_value = true;
    await setSession(env, chatId, session);
    await editMessage(cfg.botToken, chatId, messageId, encodeMethodPrompt(session.codec, method));
    return;
  }

  if (data === "autoref_ok" && session.encode_method === "auto") {
    session.target_value = session.target_value || "85";
    await setSession(env, chatId, session);
    await editMessage(cfg.botToken, chatId, messageId, `✅ جودة تلقائية بدرجة VMAF مستهدفة ${session.target_value}`);
    await sendQualityKeyboard(cfg.botToken, chatId, RESOLUTIONS);
    return;
  }

  if (data === "autoref_custom" && session.encode_method === "auto") {
    session.awaiting_target_value = true;
    await setSession(env, chatId, session);
    await editMessage(cfg.botToken, chatId, messageId, encodeMethodPrompt(session.codec, "auto"));
    return;
  }

  // ============ التسمية التلقائية ============
  if (data === "autoname_keep") {
    session.auto_naming = "source";
    delete session.series_title;
    delete session.next_episode;
    await setSession(env, chatId, session);
    await editMessage(cfg.botToken, chatId, messageId, "📄 سيحتفظ كل ملف باسمه المرفق تلقائياً.");
    await savePresetAndConfirm(env, cfg.botToken, chatId, session);
    return;
  }

  if (data === "autoname_series") {
    session.auto_naming = "series";
    session.awaiting_series_title = true;
    await setSession(env, chatId, session);
    await editMessage(
      cfg.botToken,
      chatId,
      messageId,
      "📝 أرسل اسم السلسلة كما تريد ظهوره.\nمثال: Solo Leveling S02\n\nسيكون الناتج: Solo Leveling S02 - E01\n\nللإلغاء أرسل /cancel",
    );
    return;
  }

  // ============ الدقة ============
  if (data === "custom_res") {
    session.awaiting_res = true;
    await setSession(env, chatId, session);
    await editMessage(cfg.botToken, chatId, messageId, "📐 أرسل الارتفاع المطلوب رقماً فقط، مثال: 550:\n\nللإلغاء أرسل /cancel");
    return;
  }

  if (data === "auto_res") {
    session.resolution = "auto";
    await setSession(env, chatId, session);
    await editMessage(cfg.botToken, chatId, messageId, "🎯 تم اختيار: نفس جودة الفيديو الأصلية");
    await continueAfterResolution(env, cfg.botToken, chatId, session);
    return;
  }

  if (data.startsWith("res_")) {
    const resolution = data.split("_")[1];
    if (!isValidResolution(resolution)) return;
    session.resolution = resolution;
    await setSession(env, chatId, session);
    await editMessage(cfg.botToken, chatId, messageId, `🎯 تم اختيار الدقة: ${resolution}p`);
    await continueAfterResolution(env, cfg.botToken, chatId, session);
    return;
  }

  if (data === "name_skip") {
    session.filename = cleanFileName(session.default_name) || "video";
    await askConfirmation(env, cfg, chatId, session);
    return;
  }
}

// ---------------------------------------------------------------------------
// أدوات الأمان
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// الروابط والأسماء
// ---------------------------------------------------------------------------

function isAnyLink(text) {
  return /^https?:\/\/\S+$/i.test(text);
}

function extractLinkInfo(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, "");
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    let lastPart = pathParts[pathParts.length - 1] || "";
    try {
      lastPart = decodeURIComponent(lastPart);
    } catch {
      // نُبقي الاسم كما هو إن كان الترميز غير صالح.
    }

    const name = MEDIA_EXT_RE.test(lastPart)
      ? lastPart
      : generateNameFromLink(hostname, parsed, lastPart);

    return {
      name: cleanFileName(name) || `video_${Date.now()}`,
      hostname,
      fullUrl: url,
    };
  } catch {
    return {
      name: `video_${Date.now()}`,
      hostname: "unknown",
      fullUrl: url,
    };
  }
}

function generateNameFromLink(hostname, parsed, lastPart) {
  const videoId = parsed.searchParams.get("v");
  if (videoId) return `${hostname}_${videoId}`;

  const cleaned = cleanFileName(lastPart.replace(/\.(php|html?|aspx?|jsp)$/i, ""));
  if (cleaned && lastPart.length < 100) return `${hostname}_${cleaned}`;

  return `${hostname}_${Date.now()}`;
}

function cleanFileName(value) {
  const cleaned = String(value || "")
    .replace(MEDIA_EXT_RE, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned)
    .slice(0, MAX_NAME_LENGTH)
    .join("")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
}

function extractDefaultName(message) {
  const raw = message.caption || message.document?.file_name || message.video?.file_name || null;
  if (!raw) return null;
  return cleanFileName(raw) || null;
}

function formatEpisode(value) {
  return String(Number.parseInt(value, 10)).padStart(2, "0");
}

// صوت مسار AV1 ثابت: Opus بمعدل 16k أحادي.
const VIDEO_AUDIO_LABEL = "Opus 16k أحادي";

function resolutionText(resolution) {
  return resolution === "auto" ? "نفس جودة الفيديو الأصلية" : `${resolution}p (بلا رفع إن كان المصدر أقل)`;
}

// ---------------------------------------------------------------------------
// الوضع التلقائي وحجز أرقام الحلقات
// ---------------------------------------------------------------------------

async function reserveAutoName(env, chatId, preset, sourceName) {
  if (
    preset.auto_naming === "series" &&
    preset.series_title &&
    Number.isInteger(preset.next_episode) &&
    preset.next_episode > 0
  ) {
    const fresh = (await getPreset(env, chatId)) || preset;
    const episode =
      Number.isInteger(fresh.next_episode) && fresh.next_episode > 0
        ? fresh.next_episode
        : preset.next_episode;
    const title = cleanFileName(fresh.series_title || preset.series_title);
    fresh.next_episode = episode + 1;
    await setPreset(env, chatId, fresh);
    return { name: `${title} - E${formatEpisode(episode)}`, episode };
  }
  return { name: cleanFileName(sourceName) || "video", episode: null };
}

async function releaseEpisode(env, chatId, episode) {
  if (!Number.isInteger(episode)) return;
  const preset = await getPreset(env, chatId);
  if (preset && preset.next_episode === episode + 1) {
    preset.next_episode = episode;
    await setPreset(env, chatId, preset);
  }
}

async function runAutomatic(env, cfg, chatId, preset, source, sourceName, label) {
  const { name, episode } = await reserveAutoName(env, chatId, preset, sourceName);

  const autoSession = {
    message_id: source.message_id,
    url: source.url,
    codec: preset.codec || "av1",
    encode_mode: preset.encode_mode || "nofilters",
    preset: preset.preset || preset.av1_preset || "8",
    encode_method: preset.encode_method || "crf",
    target_value: preset.target_value || "28",
    resolution: preset.resolution || "480",
    denoise_filter: preset.denoise_filter || FILTER_DEFAULTS.denoise_filter,
    denoise_strength: preset.denoise_strength || FILTER_DEFAULTS.denoise_strength,
    deband_filter: preset.deband_filter || FILTER_DEFAULTS.deband_filter,
    brightness_curve: preset.brightness_curve || FILTER_DEFAULTS.brightness_curve,
    saturation_boost: preset.saturation_boost || FILTER_DEFAULTS.saturation_boost,
    sharpen_filter: preset.sharpen_filter || FILTER_DEFAULTS.sharpen_filter,
    custom_denoise: preset.custom_denoise || "",
    custom_deband: preset.custom_deband || "",
    custom_brightness: preset.custom_brightness || "",
    custom_saturation: preset.custom_saturation || "",
    custom_sharpen: preset.custom_sharpen || "",
    filename: name,
    reserved_episode: episode,
    pending_confirmation: false,
  };

  await sendMessage(cfg.botToken, chatId, `${label}: ${name}`);
  await finalizeAndTrigger(env, cfg, chatId, autoSession, false);
}

// ---------------------------------------------------------------------------
// التأكيد والإرسال
// ---------------------------------------------------------------------------

function confirmKeyboardMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "✅ تأكيد", callback_data: "confirm_action" },
        { text: "🚫 إلغاء", callback_data: "cancel_action" },
      ],
    ],
  };
}

async function askConfirmation(env, cfg, chatId, session) {
  session.awaiting_filename = false;
  session.pending_confirmation = true;
  session.confirmation_message_id = null;
  await setSession(env, chatId, session);

  const summary = buildSummaryMessage(session);
  const sent = await sendMessageWithReturn(
    cfg.botToken,
    chatId,
    `📋 ملخص العملية:\n${summary}\n\nهل تريد تأكيد الإرسال؟`,
    confirmKeyboardMarkup(),
  );
  session.confirmation_message_id = sent?.result?.message_id ?? null;
  await setSession(env, chatId, session);
}

async function confirmAndSend(env, cfg, chatId, session, messageId) {
  session.pending_confirmation = false;
  await setSession(env, chatId, session);

  const text = "✅ تم تأكيد العملية. جارٍ الإرسال...";
  if (messageId) {
    await editMessage(cfg.botToken, chatId, messageId, text);
  } else {
    await sendMessage(cfg.botToken, chatId, text);
  }
  await finalizeAndTrigger(env, cfg, chatId, session, true);
}

async function finalizeAndTrigger(env, cfg, chatId, session, canRetry) {
  if (!session.message_id && !session.url) {
    await releaseEpisode(env, chatId, session.reserved_episode);
    await deleteSession(env, chatId);
    await sendMessage(cfg.botToken, chatId, "⚠️ لا يوجد فيديو أو رابط في هذه العملية. أرسل الفيديو أو الرابط من جديد.");
    return;
  }

  const success = await triggerGitHub(cfg, session, chatId);
  if (success) {
    await deleteSession(env, chatId);
    await sendMessage(cfg.botToken, chatId, "✅ تم إرسال المهمة إلى مصنع الضغط السحابي.");
    return;
  }

  await releaseEpisode(env, chatId, session.reserved_episode);
  if (canRetry) {
    session.pending_confirmation = true;
    await setSession(env, chatId, session);
    await sendMessage(
      cfg.botToken,
      chatId,
      "❌ فشل إرسال المهمة إلى GitHub. تحقق من سجل العامل ورمز GitHub.\nأرسل /confirm لإعادة المحاولة أو /cancel للإلغاء.",
    );
  } else {
    await deleteSession(env, chatId);
    await sendMessage(cfg.botToken, chatId, "❌ فشل إرسال المهمة إلى GitHub. تحقق من سجل العامل ورمز GitHub ثم أعد إرسال الفيديو.");
  }
}

async function triggerGitHub(cfg, session, chatId) {
  if (!cfg.githubToken) {
    console.error("GITHUB_TOKEN is not configured");
    return false;
  }

  const body = {
    ref: cfg.ref,
    inputs: {
      message_id: session.message_id ? String(session.message_id) : "",
      url: session.url || "",
      chat_id: String(chatId),
      filename: session.filename || "video",
      codec: session.codec || "av1",
      preset: session.preset || "8",
      encode_mode: session.encode_mode || "nofilters",
      encode_method: session.encode_method || "crf",
      target_value: String(session.target_value || "28"),
      resolution: session.resolution || "480",
      frame_rate: "24",
      denoise_filter: session.denoise_filter || FILTER_DEFAULTS.denoise_filter,
      denoise_strength: session.denoise_strength || FILTER_DEFAULTS.denoise_strength,
      deband_filter: session.deband_filter || FILTER_DEFAULTS.deband_filter,
      brightness_curve: session.brightness_curve || FILTER_DEFAULTS.brightness_curve,
      saturation_boost: session.saturation_boost || FILTER_DEFAULTS.saturation_boost,
      sharpen_filter: session.sharpen_filter || FILTER_DEFAULTS.sharpen_filter,
      custom_denoise: session.custom_denoise || "",
      custom_deband: session.custom_deband || "",
      custom_brightness: session.custom_brightness || "",
      custom_saturation: session.custom_saturation || "",
      custom_sharpen: session.custom_sharpen || "",
    },
  };

  const response = await fetch(
    `https://api.github.com/repos/${cfg.repo}/actions/workflows/${cfg.workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Cloudflare-Worker",
      },
      body: JSON.stringify(body),
    },
  );

  const responseText = await response.text();
  if (!response.ok) {
    console.error("GitHub workflow dispatch failed:", {
      status: response.status,
      repository: cfg.repo,
      workflow: cfg.workflow,
      detail: responseText.slice(0, 1500),
    });
    return false;
  }

  console.log("GitHub workflow dispatched:", {
    status: response.status,
    repository: cfg.repo,
    workflow: cfg.workflow,
  });
  return true;
}

// ---------------------------------------------------------------------------
// النصوص والملخصات
// ---------------------------------------------------------------------------

function filtersActive(session) {
  // هل هناك أي فلتر فعّال (ليس off)؟
  return (
    (session.denoise_filter && session.denoise_filter !== "off") ||
    (session.deband_filter && session.deband_filter !== "off") ||
    (session.brightness_curve && session.brightness_curve !== "off") ||
    (session.saturation_boost && session.saturation_boost !== "off") ||
    (session.sharpen_filter && session.sharpen_filter !== "off") ||
    (session.custom_denoise && session.custom_denoise.length > 0) ||
    (session.custom_deband && session.custom_deband.length > 0) ||
    (session.custom_brightness && session.custom_brightness.length > 0) ||
    (session.custom_saturation && session.custom_saturation.length > 0) ||
    (session.custom_sharpen && session.custom_sharpen.length > 0)
  );
}

function buildSummaryMessage(session) {
  const codecLabel = session.codec === "audio" ? "صوت فقط" : "AV1";
  const methodLabel =
    session.encode_method === "crf"
      ? "CRF"
      : session.encode_method === "twopass"
        ? "Two-Pass"
        : session.encode_method === "auto"
          ? "جودة تلقائية (Av1an)"
          : "استخراج صوت";
  const resolutionLabel = resolutionText(session.resolution);

  const lines = [
    `📁 اسم الملف: ${session.filename || "غير محدد"}`,
    `🎞️ المرمّز: ${codecLabel}`,
    `🏎️ السرعة: ${session.preset || "-"}`,
    `🎛️ الطريقة: ${methodLabel}`,
    `📊 ${session.encode_method === "auto" ? "VMAF المستهدف" : "القيمة"}: ${session.target_value || "-"}`,
  ];

  if (session.codec !== "audio") {
    lines.push(`🎯 الدقة: ${resolutionLabel}`);

    if (session.encode_mode === "filters") {
      if (filtersActive(session)) {
        lines.push("");
        lines.push("🧩 الفلاتر:");
        lines.push(`  • تنعيم: ${session.denoise_filter || "off"} / ${session.denoise_strength || "medium"}`);
        lines.push(`  • بانديج: ${session.deband_filter || "off"}`);
        lines.push(`  • سطوع: ${session.brightness_curve || "off"}`);
        lines.push(`  • تشبع: ${session.saturation_boost || "off"}`);
        lines.push(`  • حدة: ${session.sharpen_filter || "off"}`);

        const customs = [];
        if (session.custom_denoise) customs.push(`تنعيم=${session.custom_denoise}`);
        if (session.custom_deband) customs.push(`بانديج=${session.custom_deband}`);
        if (session.custom_brightness) customs.push(`سطوع=${session.custom_brightness}`);
        if (session.custom_saturation) customs.push(`تشبع=${session.custom_saturation}`);
        if (session.custom_sharpen) customs.push(`حدة=${session.custom_sharpen}`);
        if (customs.length > 0) {
          lines.push("  • مخصص: " + customs.join(" | "));
        }
      } else {
        lines.push("🧩 الفلاتر: معطّلة فعلياً (كل الخيارات off)");
      }
    } else {
      lines.push("🖼️ الوضع: بدون فلاتر");
    }

    lines.push(`🔊 الصوت: ${VIDEO_AUDIO_LABEL}`);
  }

  return lines.join("\n");
}

function presetStatusText(preset) {
  if (!preset) return "لا يوجد إعداد محفوظ.";

  const codecLabel = preset.codec === "audio" ? "صوت فقط" : "AV1";
  const methodLabel =
    preset.encode_method === "crf"
      ? "CRF"
      : preset.encode_method === "twopass"
        ? "Two-Pass"
        : preset.encode_method === "auto"
          ? "جودة تلقائية (Av1an)"
          : "استخراج صوت";
  const resolutionLabel = resolutionText(preset.resolution);

  const lines = [
    `المرمّز: ${codecLabel}`,
    `السرعة: ${preset.preset || "-"}`,
    `الطريقة: ${methodLabel}`,
    `${preset.encode_method === "auto" ? "VMAF المستهدف" : "القيمة"}: ${preset.target_value}`,
  ];

  if (preset.codec !== "audio") {
    lines.push(`الدقة: ${resolutionLabel}`);

    if (preset.encode_mode === "filters") {
      lines.push(
        `الفلاتر: تنعيم=${preset.denoise_filter || "off"}/${preset.denoise_strength || "medium"} ` +
          `بانديج=${preset.deband_filter || "off"} ` +
          `سطوع=${preset.brightness_curve || "off"} ` +
          `تشبع=${preset.saturation_boost || "off"} ` +
          `حدة=${preset.sharpen_filter || "off"}`,
      );
    } else {
      lines.push("الوضع: بدون فلاتر");
    }

    lines.push(`الصوت: ${VIDEO_AUDIO_LABEL}`);
  }

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
    "",
    "🧩 فلاتر الصورة (عند اختيار «مع فلاتر»):",
    "- 6 فلاتر رئيسية: تنعيم، بانديج، سطوع، تشبع، حدة",
    "- و5 حقول مخصصة للتحكم اليدوي الكامل",
    preset?.active ? "" : null,
    preset?.active ? "▶️ الوضع التلقائي مفعّل حالياً." : null,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}

// ---------------------------------------------------------------------------
// التحقق من القيم
// ---------------------------------------------------------------------------

function isValidPreset(codec, value) {
  if (codec === "av1") return /^(?:[0-9]|1[0-3])$/.test(value);
  return codec === "audio";
}

function isValidEncodeMethod(codec, method) {
  if (codec === "av1") return ["crf", "twopass", "auto"].includes(method);
  if (codec === "audio") return method === "audio";
  return false;
}

function parseBitrate(value) {
  const match = /^([1-9]\d{0,5})([kKmM])?$/.exec(String(value).trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || "k").toLowerCase();
  return unit === "m"
    ? { bps: amount * 1_000_000, text: `${amount}M` }
    : { bps: amount * 1_000, text: `${amount}k` };
}

function normalizeBitrate(value, minBps, maxBps) {
  const parsed = parseBitrate(value);
  if (!parsed || parsed.bps < minBps || parsed.bps > maxBps) return null;
  return parsed.text;
}

const AUDIO_BITRATE_RANGE = [6_000, 510_000];
const VIDEO_BITRATE_RANGE = [20_000, 50_000_000];

function normalizeTargetValue(codec, method, value) {
  const text = String(value).trim();
  if (codec === "audio") return normalizeBitrate(text, ...AUDIO_BITRATE_RANGE);
  if (codec === "av1" && method === "twopass") return normalizeBitrate(text, ...VIDEO_BITRATE_RANGE);
  if (codec === "av1" && method === "crf") {
    return /^(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(text) ? text : null;
  }
  if (codec === "av1" && method === "auto") {
    return /^(?:[5-9][0-9])$/.test(text) ? text : null;
  }
  return null;
}

function isValidResolution(value) {
  if (!/^\d{3,4}$/.test(value)) return false;
  const height = Number.parseInt(value, 10);
  return height >= 144 && height <= 2160;
}

function presetPrompt() {
  return "أرسل رقم سرعة AV1 من 0 إلى 13، مثل 4 أو 8.";
}

function denoisePrompt() {
  return (
    "🧩 اختر فلتر التنعيم (Denoise):\n\n" +
    "• 🚫 off — بلا تنعيم (للمصادر النظيفة أصلاً)\n" +
    "• ⚡ hqdn3d — تنعيم مكاني سريع\n" +
    "• 🎞️ atadenoise — تنعيم زمني بين الإطارات (يحفظ الخطوط)\n" +
    "• 🌸 hqdn3d+atadenoise — الأفضل للأنمي (موصى به)\n" +
    "• 💎 nlmeans — أعلى جودة لكن بطيء جداً"
  );
}

function denoiseStrengthPrompt() {
  return (
    "🎚️ اختر شدة التنعيم:\n\n" +
    "• 🌿 light — خفيف (مصدر نظيف نسبياً)\n" +
    "• ⚖️ medium — متوسط (متوازن، موصى به)\n" +
    "• 🔥 strong — قوي (مصدر ضجيج عالٍ)"
  );
}

function debandPrompt() {
  return (
    "🧩 اختر فلتر إزالة البانديج (الطبقات اللونية):\n\n" +
    "• 🚫 off — بلا إزالة\n" +
    "• ⚡ deband — بسيط\n" +
    "• 🎨 gradfun — ذكي مع dithering (موصى به)\n" +
    "• 💎 deband+gradfun — الأقوى (الأبطأ)"
  );
}

function brightnessPrompt() {
  return (
    "🧩 اختر منحنى السطوع:\n\n" +
    "• 🚫 off — بلا تعديل\n" +
    "• ⚡ eq — رفع بسيط موحد (سريع)\n" +
    "• 🌤️ curves-light — رفع خفيف للظلال\n" +
    "• ☀️ curves-medium — رفع متوسط (موصى به)\n" +
    "• 🔥 curves-strong — رفع قوي للظلال"
  );
}

function saturationPrompt() {
  return (
    "🧩 اختر زيادة التشبع اللوني:\n\n" +
    "• 🚫 off — بلا تعديل\n" +
    "• ⚡ eq — زيادة موحدة لكل الألوان\n" +
    "• 🎨 colorbalance — متوازن الألوان (موصى به)"
  );
}

function sharpenPrompt() {
  return (
    "🧩 اختر فلتر الحدة:\n\n" +
    "• 🚫 off — بلا شحذ\n" +
    "• 🌸 cas — شحذ متكيف (ممتاز للأنمي)\n" +
    "• 🎬 unsharp — شحذ خطي (مناسب للواقعي)"
  );
}

function customFiltersPrompt() {
  return (
    "🎨 هل تريد إضافة فلاتر مخصصة؟\n\n" +
    "هذه حقول نصية تدعم أي فلتر FFmpeg. اضغط على أي حقل لإدخال قيمة.\n" +
    "إن لم تكن بحاجة إليها، اضغط ✅ تم مباشرة."
  );
}

function customFilterHint(field) {
  const hints = {
    denoise:
      "🎨 أرسل فلتر التنعيم المخصص.\n" +
      "مثال: hqdn3d=1.5:1.0:2.0:1.5\n" +
      "أرسل «حذف» لإزالته.",
    deband:
      "🎨 أرسل فلتر البانديج المخصص.\n" +
      "مثال: gradfun=strength=2.0:radius=20\n" +
      "أرسل «حذف» لإزالته.",
    brightness:
      "🎨 أرسل فلتر السطوع المخصص.\n" +
      "مثال: eq=brightness=0.08\n" +
      "أو: curves=all='0/0 0.2/0.30 1/1'\n" +
      "أرسل «حذف» لإزالته.",
    saturation:
      "🎨 أرسل فلتر التشبع المخصص.\n" +
      "مثال: eq=saturation=1.2\n" +
      "أرسل «حذف» لإزالته.",
    sharpen:
      "🎨 أرسل فلتر الحدة المخصص.\n" +
      "مثال: unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.5\n" +
      "أرسل «حذف» لإزالته.",
  };
  return (hints[field] || "أرسل قيمة الفلتر:") + "\n\nللإلغاء أرسل /cancel";
}

function targetValueHint(codec, method) {
  if (codec === "audio") return "أرسل معدل بت بين 6k و510k، مثل 32k أو 48k (بدون وحدة تُعتبر k).";
  if (codec === "av1" && method === "crf") return "أرسل قيمة CRF من 0 إلى 63، مثل 28 أو 35.";
  if (codec === "av1" && method === "auto") return "أرسل درجة VMAF مستهدفة من 50 إلى 99، مثل 85.";
  return "أرسل معدل بت بين 20k و50M، مثل 250k أو 1000k (بدون وحدة تُعتبر k).";
}

function encodeMethodPrompt(codec, method) {
  if (codec === "av1" && method === "crf") {
    return "تم اختيار CRF. أرسل قيمة CRF من 0 إلى 63، مثل 28 أو 35:";
  }
  if (codec === "av1" && method === "auto") {
    return "أرسل درجة VMAF مستهدفة للجودة التلقائية (من 50 إلى 99)، مثل 85:";
  }
  if (codec === "av1" && method === "twopass") {
    return "تم اختيار Two-Pass. أرسل معدل البت المستهدف، مثل 250k أو 1000k:";
  }
  return "أرسل معدل البت المستهدف، مثل 250k أو 1000k:";
}

// ---------------------------------------------------------------------------
// الجلسات والإعدادات المحفوظة (KV)
// ---------------------------------------------------------------------------

function ok() {
  return new Response("OK", { status: 200 });
}

async function getSession(env, chatId) {
  const raw = await env.SESSIONS.get(`session:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

async function setSession(env, chatId, session) {
  await env.SESSIONS.put(`session:${chatId}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
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
  const preset = {
    codec: session.codec || "av1",
    encode_mode: session.encode_mode || "nofilters",
    preset: session.preset || "8",
    encode_method: session.encode_method || "crf",
    target_value: session.target_value || "28",
    resolution: session.resolution || "480",
    auto_naming: session.auto_naming || "source",
    active: true,
    denoise_filter: session.denoise_filter || FILTER_DEFAULTS.denoise_filter,
    denoise_strength: session.denoise_strength || FILTER_DEFAULTS.denoise_strength,
    deband_filter: session.deband_filter || FILTER_DEFAULTS.deband_filter,
    brightness_curve: session.brightness_curve || FILTER_DEFAULTS.brightness_curve,
    saturation_boost: session.saturation_boost || FILTER_DEFAULTS.saturation_boost,
    sharpen_filter: session.sharpen_filter || FILTER_DEFAULTS.sharpen_filter,
    custom_denoise: session.custom_denoise || "",
    custom_deband: session.custom_deband || "",
    custom_brightness: session.custom_brightness || "",
    custom_saturation: session.custom_saturation || "",
    custom_sharpen: session.custom_sharpen || "",
  };

  if (session.auto_naming === "series") {
    preset.series_title = cleanFileName(session.series_title);
    preset.next_episode = Number.parseInt(session.next_episode, 10);
  }

  await setPreset(env, chatId, preset);
  await deleteSession(env, chatId);
  await sendMessage(
    botToken,
    chatId,
    `✅ تم حفظ الإعداد وتفعيل الوضع التلقائي.\n${presetStatusText(preset)}\n⏸️ استخدم /auto_off لإيقافه.`,
  );
}

// ---------------------------------------------------------------------------
// لوحات المفاتيح
// ---------------------------------------------------------------------------

async function promptFilename(botToken, chatId, editMessageId, defaultName, useEdit) {
  const text = defaultName
    ? `الاسم المرفق: ${defaultName}\n\nأرسل اسماً جديداً، أو اضغط «✅ استخدام الاسم المرفق».`
    : "أرسل الاسم النهائي للملف:";
  const keyboard = defaultName
    ? {
        inline_keyboard: [
          [{ text: "✅ استخدام الاسم المرفق", callback_data: "name_skip" }],
          [{ text: "🚫 إلغاء", callback_data: "cancel" }],
        ],
      }
    : {
        inline_keyboard: [[{ text: "🚫 إلغاء", callback_data: "cancel" }]],
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

function denoiseFilterKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🚫 بلا تنعيم (off)", callback_data: "denoise_off" }],
      [{ text: "⚡ سريع مكاني (hqdn3d)", callback_data: "denoise_hqdn3d" }],
      [{ text: "🎞️ زمني (atadenoise)", callback_data: "denoise_atadenoise" }],
      [{ text: "🌸 للأنمي (hqdn3d+atadenoise)", callback_data: "denoise_hqdn3d+atadenoise" }],
      [{ text: "💎 أعلى جودة (nlmeans)", callback_data: "denoise_nlmeans" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
}

function denoiseStrengthKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🌿 خفيف (light)", callback_data: "dstrength_light" }],
      [{ text: "⚖️ متوسط (medium)", callback_data: "dstrength_medium" }],
      [{ text: "🔥 قوي (strong)", callback_data: "dstrength_strong" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
}

function debandFilterKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🚫 بلا (off)", callback_data: "deband_off" }],
      [{ text: "⚡ بسيط (deband)", callback_data: "deband_deband" }],
      [{ text: "🎨 ذكي (gradfun)", callback_data: "deband_gradfun" }],
      [{ text: "💎 الأقوى (deband+gradfun)", callback_data: "deband_deband+gradfun" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
}

function brightnessKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🚫 بلا (off)", callback_data: "bright_off" }],
      [{ text: "⚡ سريع (eq)", callback_data: "bright_eq" }],
      [{ text: "🌤️ خفيف (curves-light)", callback_data: "bright_curves-light" }],
      [{ text: "☀️ متوسط (curves-medium)", callback_data: "bright_curves-medium" }],
      [{ text: "🔥 قوي (curves-strong)", callback_data: "bright_curves-strong" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
}

function saturationKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🚫 بلا (off)", callback_data: "sat_off" }],
      [{ text: "⚡ موحد (eq)", callback_data: "sat_eq" }],
      [{ text: "🎨 متوازن (colorbalance)", callback_data: "sat_colorbalance" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
}

function sharpenKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🚫 بلا (off)", callback_data: "sharp_off" }],
      [{ text: "🌸 متكيف (cas)", callback_data: "sharp_cas" }],
      [{ text: "🎬 خطي (unsharp)", callback_data: "sharp_unsharp" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
  };
}

function customFiltersKeyboardMarkup(session = {}) {
  const rows = [];
  const fields = [
    ["denoise", "🎨 تنعيم مخصص"],
    ["deband", "🎨 بانديج مخصص"],
    ["brightness", "🎨 سطوع مخصص"],
    ["saturation", "🎨 تشبع مخصص"],
    ["sharpen", "🎨 حدة مخصصة"],
  ];

  for (const [key, label] of fields) {
    const current = session[`custom_${key}`];
    let text;
    if (current) {
      // احترام حد تيليجرام لطول نص الزر (64 حرف)
      const preview = current.length > 28 ? current.slice(0, 25) + "..." : current;
      text = `${label}: ${preview}`;
      if (text.length > 60) text = text.slice(0, 57) + "...";
    } else {
      text = label;
    }
    rows.push([{ text, callback_data: `custom_edit_${key}` }]);
  }

  rows.push([{ text: "✅ تم", callback_data: "custom_done" }]);
  rows.push([{ text: "⏭️ تخطي الفلاتر المخصصة", callback_data: "custom_skip" }]);
  rows.push([{ text: "🚫 إلغاء", callback_data: "cancel" }]);

  return { inline_keyboard: rows };
}

function cancelOnlyKeyboardMarkup() {
  return {
    inline_keyboard: [[{ text: "🚫 إلغاء", callback_data: "cancel" }]],
  };
}

async function sendEncodeMethodKeyboard(botToken, chatId) {
  await sendMessage(botToken, chatId, "🎛️ اختر طريقة ترميز AV1:", encodeMethodKeyboardMarkup());
}

function encodeMethodKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🎚️ ضغط ذكي (CRF)", callback_data: "encmethod_crf" }],
      [{ text: "⚖️ حجم مضبوط (Two-Pass)", callback_data: "encmethod_twopass" }],
      [{ text: "🎯 جودة تلقائية (Av1an)", callback_data: "encmethod_auto" }],
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

// ---------------------------------------------------------------------------
// تيليجرام
// ---------------------------------------------------------------------------

async function sendTelegram(botToken, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error(`Telegram ${method} failed:`, response.status, await response.text());
    return { ok: false };
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

async function deleteMessage(botToken, chatId, messageId) {
  if (!messageId) return;
  try {
    await sendTelegram(botToken, "deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    // الحذف تحسين أمني فقط.
  }
}

async function answerCallback(botToken, callbackQueryId) {
  await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: callbackQueryId });
}
