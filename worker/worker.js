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

// امتدادات الوسائط فقط. لا نحذف أي "امتداد" عشوائي حتى لا نخسر أجزاء من الاسم
// مثل ".E01" في "Show S02.E01" أو ".0" في "Movie 2.0".
const MEDIA_EXT_RE =
  /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mts|vob|3gp|3g2|ogv|mpeg|mpg|m3u8|mp3|m4a|aac|opus|ogg|wav|flac)$/i;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    // حماية اختيارية: تأكد أن الطلب قادم فعلاً من تيليجرام.
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
          // لا شيء: الإشعار محاولة بأفضل جهد فقط.
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

// هل المستخدم في منتصف إعداد يحتاج إكماله (أو إلغاءه) قبل بدء مهمة جديدة؟
function isSetupBusy(session) {
  return Boolean(
    session.configuring_preset ||
      session.awaiting_preset ||
      session.awaiting_target_value ||
      session.awaiting_res ||
      session.awaiting_filename ||
      session.awaiting_series_title ||
      session.awaiting_episode_start ||
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

  // وضع الإعداد التلقائي: يستعمل الإعداد المحفوظ مباشرة.
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

  // جلسة يدوية جديدة.
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

  // "/start@MyBot" ← "/start"
  const text = rawText.replace(/^(\/[A-Za-z0-9_]+)@\w+/, "$1");
  const session = (await getSession(env, chatId)) || {};

  // قبول أي رابط.
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

  // رسائل التأكيد.
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

  // الأوامر.
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

  // مدخلات الإعداد النصية.
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
    session.resolution = String(Number.parseInt(text, 10)); // "0480" ← "480"
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

// كلمة المرور: مقارنة ثابتة الزمن + حذف الرسالة + حد للمحاولات الفاشلة.
async function handleUnauthorizedText(env, cfg, message, rawText) {
  const chatId = message.chat.id;
  const prompt = "🔒 هذا البوت خاص. أرسل كلمة المرور للمتابعة:";

  // الأوامر (مثل /start) ليست محاولات كلمة مرور.
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
  if (!message) return; // رسالة قديمة جداً لم تعد متاحة لتيليجرام.

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

  // أي زر آخر يحتاج جلسة حيّة؛ أزرار الرسائل القديمة (بعد انتهاء الجلسة) تُرفض.
  if (!hasActiveSession(session)) {
    await editMessage(cfg.botToken, chatId, messageId, "⌛ انتهت صلاحية هذه العملية. أرسل الفيديو أو الرابط من جديد.");
    return;
  }

  if (data.startsWith("codec_")) {
    const codec = data.split("_")[1];
    if (!["av1", "audio"].includes(codec)) return;

    session.codec = codec;
    if (codec === "audio") {
      session.encode_mode = "audio";
      session.filter_profile = "none";
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

  if (data.startsWith("mode_")) {
    const mode = data.split("_")[1];
    if (!["filters", "nofilters"].includes(mode)) return;

    session.encode_mode = mode;
    session.filter_profile = mode === "nofilters" ? "none" : undefined;
    await setSession(env, chatId, session);

    if (mode === "filters") {
      await editMessage(
        cfg.botToken,
        chatId,
        messageId,
        "🧩 اختر نوع الفلاتر: الأنمي للرسوم والمساحات اللونية، والواقعي للتصوير الحقيقي:",
        filterProfileKeyboardMarkup(),
      );
    } else {
      session.awaiting_preset = true;
      await setSession(env, chatId, session);
      await editMessage(cfg.botToken, chatId, messageId, presetPrompt());
    }
    return;
  }

  if (data.startsWith("filter_")) {
    const profile = data.split("_")[1];
    if (!["anime", "realistic"].includes(profile)) return;

    session.filter_profile = profile;
    session.awaiting_preset = true;
    await setSession(env, chatId, session);
    await editMessage(
      cfg.botToken,
      chatId,
      messageId,
      `${profile === "anime" ? "🌸 تم اختيار فلاتر الأنمي." : "🎬 تم اختيار فلاتر المحتوى الواقعي."}\n${presetPrompt()}`,
    );
    return;
  }

  if (data.startsWith("encmethod_")) {
    const method = data.split("_")[1];
    if (!isValidEncodeMethod(session.codec, method)) return;

    session.encode_method = method;
    session.awaiting_target_value = true;
    await setSession(env, chatId, session);
    await editMessage(cfg.botToken, chatId, messageId, encodeMethodPrompt(session.codec, method));
    return;
  }

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
      ? lastPart // cleanFileName يحذف امتداد الوسائط
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
  const videoId = parsed.searchParams.get("v"); // روابط على نمط watch?v=...
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
  // القطع بالأحرف الكاملة (وليس وحدات UTF-16) حتى لا نكسر الإيموجي.
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

// صوت مسار AV1 ثابت: Opus بمعدل 16k أحادي (قرار المستخدم: أصغر حجم وأهدأ صوت).
// يطابق ما يُطبَّقه compress.yml (-b:a 16k -ac 1).
const VIDEO_AUDIO_LABEL = "Opus 16k أحادي";

// الدقة المختارة لا ترفع دقة مصدر أقل منها (يطبّق compress.yml: min(ارتفاع المصدر, المختارة)).
function resolutionText(resolution) {
  return resolution === "auto" ? "نفس جودة الفيديو الأصلية" : `${resolution}p (بلا رفع إن كان المصدر أقل)`;
}

// ---------------------------------------------------------------------------
// الوضع التلقائي وحجز أرقام الحلقات
// ---------------------------------------------------------------------------

// نحجز رقم الحلقة (قراءة ثم زيادة فورية) قبل إرسال المهمة، بدل زيادته بعد نجاح
// الإرسال؛ هذا يقلل كثيراً فرصة أن تأخذ رسالتان متزامنتان الرقم نفسه.
// (KV ليس ذرّياً؛ للضمان الكامل استعمل Durable Object.)
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
    filter_profile:
      preset.filter_profile || (preset.encode_mode === "filters" ? "realistic" : "none"),
    preset: preset.preset || preset.av1_preset || "8",
    encode_method: preset.encode_method || "crf",
    target_value: preset.target_value || "28",
    resolution: preset.resolution || "480",
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
    // نُبقي الجلسة لتعيد المحاولة دون إعادة الإعدادات كلها.
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
      preset: session.preset || "4",
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

function buildSummaryMessage(session) {
  const codecLabel = session.codec === "audio" ? "صوت فقط" : "AV1";
  const modeLabel =
    session.encode_mode === "filters"
      ? session.filter_profile === "anime"
        ? "مع فلاتر الأنمي"
        : "مع فلاتر الواقعي"
      : session.encode_mode === "audio"
        ? "صوت فقط"
        : "بدون فلاتر";
  const methodLabel =
    session.encode_method === "crf"
      ? "CRF"
      : session.encode_method === "twopass"
        ? "Two-Pass"
        : "استخراج صوت";
  const resolutionLabel = resolutionText(session.resolution);

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
    lines.push(`🔊 الصوت: ${VIDEO_AUDIO_LABEL}`);
  }

  return lines.join("\n");
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
  const resolutionLabel = resolutionText(preset.resolution);

  const lines = [
    `المرمّز: ${codecLabel}`,
    `الوضع: ${modeLabel}`,
    `السرعة: ${preset.preset || "-"}`,
    `الطريقة: ${methodLabel}`,
    `القيمة: ${preset.target_value}`,
  ];
  if (preset.codec !== "audio") {
    lines.push(`الدقة: ${resolutionLabel}`);
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
  if (codec === "av1") return ["crf", "twopass"].includes(method);
  if (codec === "audio") return method === "audio";
  return false;
}

// ffmpeg يعامل "m" الصغيرة كـ milli (أي 1m = 0.001)! لذلك نوحّد الصيغة:
// بدون وحدة ← k ، و m/M ← M ، والنتيجة دائماً "48k" أو "2M".
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

// يعيد القيمة الموحّدة أو null إن كانت غير صالحة.
function normalizeTargetValue(codec, method, value) {
  const text = String(value).trim();
  if (codec === "audio") return normalizeBitrate(text, ...AUDIO_BITRATE_RANGE);
  if (codec === "av1" && method === "twopass") return normalizeBitrate(text, ...VIDEO_BITRATE_RANGE);
  if (codec === "av1" && method === "crf") {
    return /^(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(text) ? text : null;
  }
  return null;
}

function isValidResolution(value) {
  if (!/^\d{3,4}$/.test(value)) return false;
  const height = Number.parseInt(value, 10);
  return height >= 144 && height <= 2160;
}

function presetPrompt() {
  return "أرسل رقم سرعة AV1 من 0 إلى 13 (الموصى به للتوفير الأقصى: 4، وللسرعة: 8):";
}

function targetValueHint(codec, method) {
  if (codec === "audio") return "أرسل معدل بت بين 6k و510k، مثل 32k أو 48k (بدون وحدة تُعتبر k).";
  if (codec === "av1" && method === "crf") return "أرسل قيمة CRF من 0 إلى 63، مثل 28 أو 35.";
  return "أرسل معدل بت بين 20k و50M، مثل 250k أو 1000k (بدون وحدة تُعتبر k).";
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

function filterProfileKeyboardMarkup() {
  return {
    inline_keyboard: [
      [{ text: "🌸 أنمي", callback_data: "filter_anime" }],
      [{ text: "🎬 محتوى واقعي", callback_data: "filter_realistic" }],
      [{ text: "🚫 إلغاء", callback_data: "cancel" }],
    ],
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
    // الحذف تحسين أمني فقط؛ فشله لا يجب أن يوقف التدفق.
  }
}

async function answerCallback(botToken, callbackQueryId) {
  await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: callbackQueryId });
}
