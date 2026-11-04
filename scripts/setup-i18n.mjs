// setup-i18n.mjs — language table for the interactive installer (Q3).
//
// Locale ids align with Hermes's bundled locales
// (apps/desktop/src/i18n/languages.ts LOCALE_OPTIONS): en, zh, zh-hant, ja,
// ar, ru, fr, de, es. The interactive flow lives in setup.mjs (no args + TTY);
// this module only carries the strings and locale resolution so the table can
// be developed and parity-checked independently.
//
// en / zh / zh-hant are the authoritative copies; ja, ar, ru, fr, de, es are
// complete drafts flagged for maintainer review (README + release notes say
// so until reviewed). Fallback chain when translating: locale -> en -> key.
//
// Self-check: node scripts/setup-i18n.mjs --check   (key parity across all
// locales; exits nonzero on any drift — run after every edit to this file.)
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const LOCALES = [
  { id: 'en', endonym: 'English' },
  { id: 'zh', endonym: '简体中文' },
  { id: 'zh-hant', endonym: '繁體中文' },
  { id: 'ja', endonym: '日本語' },
  { id: 'ar', endonym: 'العربية' },
  { id: 'ru', endonym: 'Русский' },
  { id: 'fr', endonym: 'Français' },
  { id: 'de', endonym: 'Deutsch' },
  { id: 'es', endonym: 'Español' },
]

const STRINGS = {
  en: {
    title: 'Hermes Output Enhancement — installer',
    currentStatus: 'Current status',
    pluginLabel: 'Plugin',
    hostLabel: 'Host patch',
    askPlugin: 'Install or upgrade the output enhancement plugin? (y/N)',
    askHost: 'Apply the host patch (live cross-window toggle sync)?\nNote: the app must be quit first; the code-signature seal stays broken until rollback; a Hermes self-update overwrites the patch. (y/N)',
    planTitle: 'Plan (dry-run preview)',
    confirmProceed: 'Proceed with the plan above? (y/N)',
    proceeding: 'Proceeding…',
    cancelled: "Cancelled — no app or plugin files were changed.",
    complete: 'Complete installation verified: plugin + host patch.',
    pluginOnlyDone: 'Plugin step done.',
    failed: 'Failed — see the report above.',
    manualNeeded: 'Manual action required — see the report.',
    savedLanguage: 'Using saved language: {0}',
    invalidChoice: 'Invalid choice — try again.',
    unknownHostNote: 'Your Hermes build is not a registered patch target; the host-patch step is unavailable (plugin only).',
    wizardIntro: "This wizard installs or updates the output enhancement plugin and, optionally, applies the host patch. Your Hermes app and plugin files are not modified before the final confirmation; only your language preference and diagnostic reports are stored inside this checkout.",
    pluginPresent: "Plugin: installed — {0}",
    pluginAbsent: "Plugin: not installed",
    hostPatched: "Host patch: applied and verified",
    hostUnpatched: "Host patch: not applied (supported build — patch available)",
    hostUnknown: "Host patch: unknown build (patch unavailable)",
    hostVerifiedNoChange: "Host patch is already verified — no change needed.",
    nothingSelected: "Nothing selected — exiting without changes.",
    planDiagnostic: "--- plan preview (diagnostic output from the underlying tools, in English) ---",
    reportSaved: "Unified report saved: {0}",
    prefSavedNote: "Language preference saved inside this checkout (no app or plugin files were touched).",
    appPathPrompt: "Hermes.app path [Enter = {0}]: ",
    pluginTargetPrompt: "Plugin target directory [Enter = {0}]: ",
    applyNotes: "Before writing — host patch: the original file is backed up first (in-app .v2bak + an authoritative copy outside the app). The app code-signature seal becomes invalid until you roll back (rollback restores the file byte-exact and the seal — verified). A future Hermes self-update will overwrite the patch; re-run this wizard afterwards.",
    prefSaveFailed: "Could not save the language preference ({0}); continuing in this language for this run.",
    pluginForeign: "Plugin: directory exists but is not a valid install (foreign) — {0}",
    hostNoApp: "Host patch: app not inspectable ({0})",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "Plugin: not installed — would install v{0}",
    pluginPlanUpgrade: "Plugin: installed v{0} — upgradable to v{1}",
    pluginPlanLatest: "Plugin: already at the latest v{0} (identical bytes)",
    pluginPlanRefused: "Plugin target needs attention — {0} The wizard cannot proceed; use the flag mode (see README, --force) for forced handling.",
    allUpToDate: "Everything is already up to date — nothing to do.",
    completeNoop: "Done — everything was already up to date; no changes were made.",
  },
  zh: {
    title: 'Hermes Output Enhancement — 安装器',
    currentStatus: '当前状态',
    pluginLabel: '插件',
    hostLabel: '宿主补丁',
    askPlugin: '安装或更新输出增强插件？ (y/N)',
    askHost: '应用宿主补丁（跨窗口开关实时同步）？\n注意：需先退出 App；回滚前代码签名封条一直处于失效状态；Hermes 自更新会覆盖补丁。 (y/N)',
    planTitle: '计划（干跑预览）',
    confirmProceed: '按以上计划执行？(y/N)',
    proceeding: '执行中…',
    cancelled: "已取消——未修改任何 App 或插件文件。",
    complete: '完整安装验证通过：插件 + 宿主补丁。',
    pluginOnlyDone: '插件步骤完成。',
    failed: '失败 — 见上方报告。',
    manualNeeded: '需要手动处理 — 见报告。',
    savedLanguage: '使用已保存的语言：{0}',
    invalidChoice: '无效选择，请重试。',
    unknownHostNote: '当前 Hermes 构建不在已注册补丁目标内；宿主补丁步骤不可用（仅插件）。',
    wizardIntro: "本向导安装或更新输出增强插件，可选应用宿主补丁。最终确认前不会修改 Hermes App 或插件文件；仅语言偏好与诊断报告会保存在本 checkout 内。",
    pluginPresent: "插件：已安装 — {0}",
    pluginAbsent: "插件：未安装",
    hostPatched: "宿主补丁：已应用且已验证",
    hostUnpatched: "宿主补丁：未应用（受支持构建——可打补丁）",
    hostUnknown: "宿主补丁：未知构建（补丁不可用）",
    hostVerifiedNoChange: "宿主补丁已验证——无需修改。",
    nothingSelected: "未选择任何操作——不作改动退出。",
    planDiagnostic: "——计划预览（底层工具的诊断输出，英文原文）——",
    reportSaved: "统一报告已保存：{0}",
    prefSavedNote: "语言偏好已保存在本 checkout 内（未改动任何 App 或插件文件）。",
    appPathPrompt: "Hermes.app 路径 [回车 = {0}]：",
    pluginTargetPrompt: "插件目标目录 [回车 = {0}]：",
    applyNotes: "写入前说明——宿主补丁：会先备份原文件（App 内 .v2bak + App 外权威副本）。App 代码签名封条在回滚前失效（回滚可逐字节恢复文件并恢复签名——已实测）。Hermes 未来自更新会覆盖补丁，届时需重新运行本向导。",
    prefSaveFailed: "语言偏好保存失败（{0}）；本次仍按该语言继续。",
    pluginForeign: "插件：目录存在但不是有效安装（外来目录）——{0}",
    hostNoApp: "宿主补丁：App 无法检查（{0}）",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "插件：未安装——将安装 v{0}",
    pluginPlanUpgrade: "插件：已装 v{0}——可升级到 v{1}",
    pluginPlanLatest: "插件：已是最新 v{0}（字节一致）",
    pluginPlanRefused: "插件目标需人工处理——{0}向导无法继续；强制处理请用参数模式（见 README --force）。",
    allUpToDate: "一切已是最新，无需更改。",
    completeNoop: "完成——检测后一切已是最新，未做任何变更。",
  },
  'zh-hant': {
    title: 'Hermes Output Enhancement — 安裝器',
    currentStatus: '目前狀態',
    pluginLabel: '插件',
    hostLabel: '宿主補丁',
    askPlugin: '安裝或更新輸出增強插件？ (y/N)',
    askHost: '套用宿主補丁（跨視窗開關即時同步）？\n注意：需先結束 App；復原前程式碼簽章封條持續失效；Hermes 自我更新會覆蓋補丁。 (y/N)',
    planTitle: '計畫（預覽，不寫入）',
    confirmProceed: '依以上計畫執行？(y/N)',
    proceeding: '執行中…',
    cancelled: "已取消——未修改任何 App 或插件檔案。",
    complete: '完整安裝驗證通過：插件 + 宿主補丁。',
    pluginOnlyDone: '插件步驟完成。',
    failed: '失敗 — 見上方報告。',
    manualNeeded: '需要手動處理 — 見報告。',
    savedLanguage: '使用已儲存的語言：{0}',
    invalidChoice: '無效選擇，請重試。',
    unknownHostNote: '目前 Hermes 建構不在已註冊補丁目標內；宿主補丁步驟無法使用（僅插件）。',
    wizardIntro: "本精靈安裝或更新輸出增強插件，可選擇套用宿主補丁。最終確認前不會修改 Hermes App 或插件檔案；僅語言偏好與診斷報告會儲存在本 checkout 內。",
    pluginPresent: "插件：已安裝 — {0}",
    pluginAbsent: "插件：未安裝",
    hostPatched: "宿主補丁：已套用且已驗證",
    hostUnpatched: "宿主補丁：未套用（受支援建構——可套用補丁）",
    hostUnknown: "宿主補丁：未知建構（補丁無法使用）",
    hostVerifiedNoChange: "宿主補丁已驗證——無需修改。",
    nothingSelected: "未選擇任何操作——不作變更離開。",
    planDiagnostic: "——計畫預覽（底層工具的診斷輸出，英文原文）——",
    reportSaved: "統一報告已儲存：{0}",
    prefSavedNote: "語言偏好已儲存在本 checkout 內（未變更任何 App 或插件檔案）。",
    appPathPrompt: "Hermes.app 路徑 [Enter = {0}]：",
    pluginTargetPrompt: "插件目標目錄 [Enter = {0}]：",
    applyNotes: "寫入前說明——宿主補丁：會先備份原始檔案（App 內 .v2bak + App 外權威副本）。App 程式碼簽章封條在回滾前失效（回滾可逐位元組復原檔案並復原簽章——已實測）。Hermes 未來自更新會覆蓋補丁，屆時需重新執行本精靈。",
    prefSaveFailed: "語言偏好儲存失敗（{0}）；本次仍按該語言繼續。",
    pluginForeign: "插件：目錄存在但不是有效安裝（外來目錄）——{0}",
    hostNoApp: "宿主補丁：App 無法檢查（{0}）",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "插件：未安裝——將安裝 v{0}",
    pluginPlanUpgrade: "插件：已裝 v{0}——可升級到 v{1}",
    pluginPlanLatest: "插件：已是最新 v{0}（位元組一致）",
    pluginPlanRefused: "插件目標需人工處理——{0}精靈無法繼續；強制處理請用參數模式（見 README --force）。",
    allUpToDate: "一切已是最新，無需變更。",
    completeNoop: "完成——偵測後一切已是最新，未做任何變更。",
  },
  ja: {
    title: 'Hermes Output Enhancement — インストーラー',
    currentStatus: '現在の状態',
    pluginLabel: 'プラグイン',
    hostLabel: 'ホストパッチ',
    askPlugin: '出力エンハンスメントプラグインをインストールまたは更新しますか？ (y/N)',
    askHost: 'ホストパッチ（ウィンドウ間のリアルタイム同期）を適用しますか？\n注意：先にアプリを終了してください。ロールバックまでコード署名は無効のままです。Hermes の自動更新はパッチを上書きします。 (y/N)',
    planTitle: '計画（実行プレビュー・書き込みなし）',
    confirmProceed: '上記の計画を実行しますか？(y/N)',
    proceeding: '実行中…',
    cancelled: "キャンセルされました——アプリやプラグインのファイルは変更していません。",
    complete: '完全インストールを検証しました：プラグイン + ホストパッチ。',
    pluginOnlyDone: 'プラグインの手順が完了しました。',
    failed: '失敗 — 上のレポートを確認してください。',
    manualNeeded: '手動対応が必要です — レポートを確認してください。',
    savedLanguage: '保存された言語を使用中：{0}',
    invalidChoice: '無効な選択です。もう一度お試しください。',
    unknownHostNote: 'この Hermes ビルドは登録されたパッチ対象ではありません。ホストパッチの手順は利用できません（プラグインのみ）。',
    wizardIntro: "このウィザードは出力エンハンスメントプラグインのインストールまたは更新と、任意でホストパッチの適用を行います。最終確認の前に Hermes アプリやプラグインのファイルは変更されません。この checkout 内に保存されるのは言語設定と診断レポートのみです。",
    pluginPresent: "プラグイン：インストール済み — {0}",
    pluginAbsent: "プラグイン：未インストール",
    hostPatched: "ホストパッチ：適用済み・検証済み",
    hostUnpatched: "ホストパッチ：未適用（対応ビルド——適用可能）",
    hostUnknown: "ホストパッチ：不明なビルド（適用不可）",
    hostVerifiedNoChange: "ホストパッチは検証済みです——変更の必要はありません。",
    nothingSelected: "何も選択されていません——変更せずに終了します。",
    planDiagnostic: "――計画プレビュー（基盤ツールの診断出力・英語）――",
    reportSaved: "統合レポートを保存しました：{0}",
    prefSavedNote: "言語設定をこの checkout 内に保存しました（アプリやプラグインのファイルは変更していません）。",
    appPathPrompt: "Hermes.app のパス [Enter = {0}]：",
    pluginTargetPrompt: "プラグインのインストール先 [Enter = {0}]：",
    applyNotes: "書き込み前の注意——ホストパッチ：元のファイルを先にバックアップします（App 内 .v2bak + App 外の権威あるコピー）。ロールバックするまで App のコード署名は無効になります（ロールバックでバイト単位の復元と署名復帰を確認済み）。将来の Hermes 自己更新はパッチを上書きします。その後は本ウィザードを再実行してください。",
    prefSaveFailed: "言語設定を保存できませんでした（{0}）。今回はこの言語で続行します。",
    pluginForeign: "プラグイン：ディレクトリは存在しますが有効なインストールではありません（foreign）— {0}",
    hostNoApp: "ホストパッチ：アプリを検査できません（{0}）",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "プラグイン: 未インストール — v{0} をインストールします",
    pluginPlanUpgrade: "プラグイン: v{0} インストール済み — v{1} にアップグレード可能",
    pluginPlanLatest: "プラグイン: 最新 v{0}（バイト一致）",
    pluginPlanRefused: "プラグインの対象には手動対応が必要です — {0}ウィザードは続行できません。強制処理はフラグモード（README の --force）を使用してください。",
    allUpToDate: "すべて最新です。変更は不要です。",
    completeNoop: "完了 — 検証時点ですべて最新のため、変更は行われませんでした。",
  },
  ar: {
    title: 'Hermes Output Enhancement — المثبّت',
    currentStatus: 'الحالة الحالية',
    pluginLabel: 'الإضافة',
    hostLabel: 'رقعة المضيف',
    askPlugin: 'تثبيت الإضافة أو تحديثها؟ (y/N)',
    askHost: 'تطبيق رقعة المضيف (مزامنة فورية للتبديل بين النوافذ)؟\nملاحظة: أغلق التطبيق أولاً؛ يبقى ختم التوقيع معطلاً حتى التراجع؛ تحديث Hermes يستبدل الرقعة. (y/N)',
    planTitle: 'الخطة (معاينة بدون كتابة)',
    confirmProceed: 'تنفيذ الخطة أعلاه؟ (y/N)',
    proceeding: 'جارٍ التنفيذ…',
    cancelled: "أُلغي — لم يتم تعديل أي ملفات للتطبيق أو الإضافة.",
    complete: 'تم التحقق من التثبيت الكامل: الإضافة + رقعة المضيف.',
    pluginOnlyDone: 'اكتملت خطوة الإضافة.',
    failed: 'فشل — راجع التقرير أعلاه.',
    manualNeeded: 'مطلوب إجراء يدوي — راجع التقرير.',
    savedLanguage: 'استخدام اللغة المحفوظة: {0}',
    invalidChoice: 'اختيار غير صالح — حاول مجدداً.',
    unknownHostNote: 'إصدار Hermes لديك ليس هدف رقعة مسجلاً؛ خطوة رقعة المضيف غير متاحة (الإضافة فقط).',
    wizardIntro: "هذا المعالج يثبّت الإضافة أو يحدّثها، ويطبّق رقعة المضيف اختيارياً. لا تُعدَّل ملفات تطبيق Hermes أو الإضافة قبل التأكيد النهائي؛ ما يُحفظ داخل هذا checkout هو تفضيل اللغة والتقارير التشخيصية فقط.",
    pluginPresent: "الإضافة: مثبّتة — {0}",
    pluginAbsent: "الإضافة: غير مثبّتة",
    hostPatched: "رقعة المضيف: مطبّقة وموثّقة",
    hostUnpatched: "رقعة المضيف: غير مطبّقة (بنية مدعومة — الرقعة متاحة)",
    hostUnknown: "رقعة المضيف: بنية غير معروفة (الرقعة غير متاحة)",
    hostVerifiedNoChange: "رقعة المضيف موثّقة بالفعل — لا حاجة لأي تغيير.",
    nothingSelected: "لم يتم اختيار أي شيء — الخروج دون تغييرات.",
    planDiagnostic: "—— معاينة الخطة (مخرجات تشخيصية من الأدوات الأساسية بالإنجليزية) ——",
    reportSaved: "تم حفظ التقرير الموحد: {0}",
    prefSavedNote: "تم حفظ تفضيل اللغة داخل هذا checkout (لم تُلمس ملفات التطبيق أو الإضافة).",
    appPathPrompt: "مسار Hermes.app [Enter = {0}]: ",
    pluginTargetPrompt: "دليل تثبيت الإضافة [Enter = {0}]: ",
    applyNotes: "ملاحظات قبل الكتابة — رقعة المضيف: تُنشأ نسخة احتياطية من الملف الأصلي أولاً (.v2bak داخل التطبيق + نسخة موثوقة خارجه). يصبح ختم توقيع التطبيق غير صالح حتى التراجع (التراجع يستعيد الملف بايت ببايت ويعيد الختم — مثبت). التحديث الذاتي المستقبلي لـ Hermes سيستبدل الرقعة؛ أعد تشغيل هذا المعالج بعدها.",
    prefSaveFailed: "تعذّر حفظ تفضيل اللغة ({0})؛ سيتم المتابعة بهذه اللغة لهذه الجلسة.",
    pluginForeign: "الإضافة: الدليل موجود لكنه ليس تثبيتاً صالحاً (غريب) — {0}",
    hostNoApp: "رقعة المضيف: تعذّر فحص التطبيق ({0})",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "الإضافة: غير مثبتة — سيتم تثبيت v{0}",
    pluginPlanUpgrade: "الإضافة: مثبتة v{0} — يمكن الترقية إلى v{1}",
    pluginPlanLatest: "الإضافة: أحدث إصدار v{0} (تطابق كامل)",
    pluginPlanRefused: "وجهة الإضافة تحتاج تدخلاً يدوياً — {0}لا يمكن للمعالج المتابعة؛ للاجبار استخدم وضع الأوامر (--force في README).",
    allUpToDate: "كل شيء محدّث — لا حاجة لأي تغيير.",
    completeNoop: "تم — كان كل شيء محدّثاً؛ لم تُجرَ أي تغييرات.",
  },
  ru: {
    title: 'Hermes Output Enhancement — установщик',
    currentStatus: 'Текущее состояние',
    pluginLabel: 'Плагин',
    hostLabel: 'Патч хоста',
    askPlugin: 'Установить или обновить плагин улучшения вывода? (y/N)',
    askHost: 'Применить патч хоста (живая синхронизация переключателя между окнами)?\nВнимание: сначала закройте приложение; подпись кода остаётся нарушенной до отката; автообновление Hermes перезапишет патч. (y/N)',
    planTitle: 'План (предпросмотр без записи)',
    confirmProceed: 'Выполнить план выше? (y/N)',
    proceeding: 'Выполняется…',
    cancelled: "Отменено — файлы приложения и плагина не изменялись.",
    complete: 'Полная установка подтверждена: плагин + патч хоста.',
    pluginOnlyDone: 'Шаг плагина завершён.',
    failed: 'Ошибка — см. отчёт выше.',
    manualNeeded: 'Требуется ручное действие — см. отчёт.',
    savedLanguage: 'Используется сохранённый язык: {0}',
    invalidChoice: 'Неверный выбор — попробуйте снова.',
    unknownHostNote: 'Ваша сборка Hermes не входит в зарегистрированные цели патча; шаг патча хоста недоступен (только плагин).',
    wizardIntro: "Этот мастер устанавливает или обновляет плагин улучшения вывода и, по желанию, применяет патч хоста. Файлы приложения Hermes и плагина не изменяются до финального подтверждения; внутри этого checkout сохраняются только языковая настройка и диагностические отчёты.",
    pluginPresent: "Плагин: установлен — {0}",
    pluginAbsent: "Плагин: не установлен",
    hostPatched: "Патч хоста: применён и проверен",
    hostUnpatched: "Патч хоста: не применён (поддерживаемая сборка — патч доступен)",
    hostUnknown: "Патч хоста: неизвестная сборка (патч недоступен)",
    hostVerifiedNoChange: "Патч хоста уже проверен — изменения не требуются.",
    nothingSelected: "Ничего не выбрано — выход без изменений.",
    planDiagnostic: "—— предпросмотр плана (диагностический вывод инструментов, английский) ——",
    reportSaved: "Единый отчёт сохранён: {0}",
    prefSavedNote: "Языковая настройка сохранена внутри этого checkout (файлы приложения и плагина не затронуты).",
    appPathPrompt: "Путь к Hermes.app [Enter = {0}]: ",
    pluginTargetPrompt: "Каталог плагина [Enter = {0}]: ",
    applyNotes: "Перед записью — патч хоста: сначала создаётся резервная копия исходного файла (.v2bak внутри App + авторитетная копия вне App). Печать кодовой подписи приложения недействительна до отката (откат восстанавливает файл побайтово и печать — проверено). Будущее самостоятельное обновление Hermes перезапишет патч — после этого запустите этот мастер заново.",
    prefSaveFailed: "Не удалось сохранить языковую настройку ({0}); продолжаем на этом языке в текущем запуске.",
    pluginForeign: "Плагин: каталог существует, но это не валидная установка (foreign) — {0}",
    hostNoApp: "Патч хоста: приложение не удалось проверить ({0})",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "Плагин: не установлен — будет установлен v{0}",
    pluginPlanUpgrade: "Плагин: установлена v{0} — доступно обновление до v{1}",
    pluginPlanLatest: "Плагин: последняя версия v{0} (байты совпадают)",
    pluginPlanRefused: "Цель плагина требует вмешательства — {0}мастер не может продолжить; принудительная обработка — через режим флагов (--force в README).",
    allUpToDate: "Всё уже актуально — изменения не требуются.",
    completeNoop: "Готово — всё уже было актуально; изменения не вносились.",
  },
  fr: {
    title: 'Hermes Output Enhancement — installateur',
    currentStatus: 'État actuel',
    pluginLabel: 'Plugin',
    hostLabel: 'Patch hôte',
    askPlugin: 'Installer ou mettre à jour le plugin d’amélioration de la sortie ? (y/N)',
    askHost: "Appliquer le patch hôte (synchronisation en direct entre fenêtres) ?\nNote : quittez d'abord l'app ; le sceau de signature reste rompu jusqu'au rollback ; une mise à jour de Hermes écrase le patch. (y/N)",
    planTitle: 'Plan (aperçu sans écriture)',
    confirmProceed: 'Exécuter le plan ci-dessus ? (y/N)',
    proceeding: 'En cours…',
    cancelled: "Annulé — aucun fichier de l'app ou du plugin n'a été modifié.",
    complete: 'Installation complète vérifiée : plugin + patch hôte.',
    pluginOnlyDone: 'Étape plugin terminée.',
    failed: 'Échec — voir le rapport ci-dessus.',
    manualNeeded: 'Action manuelle requise — voir le rapport.',
    savedLanguage: 'Langue enregistrée utilisée : {0}',
    invalidChoice: 'Choix invalide — réessayez.',
    unknownHostNote: "Votre build de Hermes n'est pas une cible de patch enregistrée ; l'étape du patch hôte est indisponible (plugin seul).",
    wizardIntro: "Cet assistant installe ou met à jour le plugin d’amélioration de la sortie et, en option, applique le patch hôte. Les fichiers de l'app Hermes et du plugin ne sont pas modifiés avant la confirmation finale ; seuls votre préférence de langue et les rapports de diagnostic sont stockés dans ce checkout.",
    pluginPresent: "Plugin : installé — {0}",
    pluginAbsent: "Plugin : non installé",
    hostPatched: "Patch hôte : appliqué et vérifié",
    hostUnpatched: "Patch hôte : non appliqué (build pris en charge — patch disponible)",
    hostUnknown: "Patch hôte : build inconnu (patch indisponible)",
    hostVerifiedNoChange: "Le patch hôte est déjà vérifié — aucune modification nécessaire.",
    nothingSelected: "Aucune sélection — sortie sans modification.",
    planDiagnostic: "—— aperçu du plan (sortie diagnostique des outils sous-jacents, en anglais) ——",
    reportSaved: "Rapport unifié enregistré : {0}",
    prefSavedNote: "Préférence de langue enregistrée dans ce checkout (aucun fichier de l'app ou du plugin n'a été modifié).",
    appPathPrompt: "Chemin de Hermes.app [Entrée = {0}] : ",
    pluginTargetPrompt: "Répertoire cible du plugin [Entrée = {0}] : ",
    applyNotes: "Avant l'écriture — patch hôte : le fichier d'origine est d'abord sauvegardé (.v2bak dans l'app + copie de référence hors de l'app). Le sceau de signature de l'app est invalide jusqu'au rollback (le rollback restaure le fichier à l'octet près et le sceau — vérifié). Une future auto-mise à jour de Hermes écrasera le patch ; relancez cet assistant ensuite.",
    prefSaveFailed: "Impossible d'enregistrer la préférence de langue ({0}) ; poursuite dans cette langue pour cette session.",
    pluginForeign: "Plugin : le répertoire existe mais ce n'est pas une installation valide (foreign) — {0}",
    hostNoApp: "Patch hôte : l'app ne peut pas être inspectée ({0})",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "Plugin : non installé — v{0} sera installée",
    pluginPlanUpgrade: "Plugin : v{0} installée — mise à jour vers v{1} possible",
    pluginPlanLatest: "Plugin : déjà à la dernière version v{0} (octets identiques)",
    pluginPlanRefused: "La cible du plugin nécessite une intervention — {0}l’assistant ne peut pas continuer ; traitement forcé via le mode flags (--force dans le README).",
    allUpToDate: "Tout est déjà à jour — rien à faire.",
    completeNoop: "Terminé — tout était déjà à jour ; aucune modification effectuée.",
  },
  de: {
    title: 'Hermes Output Enhancement — Installer',
    currentStatus: 'Aktueller Status',
    pluginLabel: 'Plugin',
    hostLabel: 'Host-Patch',
    askPlugin: 'Output-Enhancement-Plugin installieren oder aktualisieren? (y/N)',
    askHost: 'Host-Patch anwenden (Live-Synchronisation des Schalters zwischen Fenstern)?\nHinweis: App zuerst beenden; das Codesignatur-Siegel bleibt bis zum Rollback ungültig; ein Hermes-Update überschreibt den Patch. (y/N)',
    planTitle: 'Plan (Vorschau ohne Schreibvorgang)',
    confirmProceed: 'Plan oben ausführen? (y/N)',
    proceeding: 'Wird ausgeführt…',
    cancelled: "Abgebrochen — keine App- oder Plugin-Dateien wurden verändert.",
    complete: 'Vollständige Installation verifiziert: Plugin + Host-Patch.',
    pluginOnlyDone: 'Plugin-Schritt abgeschlossen.',
    failed: 'Fehlgeschlagen — siehe Bericht oben.',
    manualNeeded: 'Manuelle Aktion erforderlich — siehe Bericht.',
    savedLanguage: 'Gespeicherte Sprache wird verwendet: {0}',
    invalidChoice: 'Ungültige Auswahl — bitte erneut versuchen.',
    unknownHostNote: 'Dein Hermes-Build ist kein registriertes Patch-Ziel; der Host-Patch-Schritt ist nicht verfügbar (nur Plugin).',
    wizardIntro: "Dieser Assistent installiert oder aktualisiert das Output-Enhancement-Plugin und wendet optional den Host-Patch an. Die Hermes-App- und Plugin-Dateien werden vor der abschließenden Bestätigung nicht verändert; gespeichert werden im Checkout nur die Spracheinstellung und Diagnoseberichte.",
    pluginPresent: "Plugin: installiert — {0}",
    pluginAbsent: "Plugin: nicht installiert",
    hostPatched: "Host-Patch: angewendet und verifiziert",
    hostUnpatched: "Host-Patch: nicht angewendet (unterstützter Build — Patch verfügbar)",
    hostUnknown: "Host-Patch: unbekannter Build (Patch nicht verfügbar)",
    hostVerifiedNoChange: "Der Host-Patch ist bereits verifiziert — keine Änderung nötig.",
    nothingSelected: "Nichts ausgewählt — Beenden ohne Änderungen.",
    planDiagnostic: "—— Planvorschau (Diagnoseausgabe der zugrunde liegenden Tools, auf Englisch) ——",
    reportSaved: "Vereinheitlichter Bericht gespeichert: {0}",
    prefSavedNote: "Spracheinstellung in diesem Checkout gespeichert (App- und Plugin-Dateien wurden nicht verändert).",
    appPathPrompt: "Pfad zu Hermes.app [Enter = {0}]: ",
    pluginTargetPrompt: "Plugin-Zielverzeichnis [Enter = {0}]: ",
    applyNotes: "Vor dem Schreiben — Host-Patch: Die Originaldatei wird zuerst gesichert (.v2bak in der App + autoritative Kopie außerhalb der App). Die Codesignatur der App ist bis zum Rollback ungültig (Rollback stellt die Datei byte-genau und das Siegel wieder — verifiziert). Ein künftiges Hermes-Selbstupdate überschreibt den Patch; danach diesen Assistenten erneut ausführen.",
    prefSaveFailed: "Spracheinstellung konnte nicht gespeichert werden ({0}); für diesen Lauf wird mit dieser Sprache fortgefahren.",
    pluginForeign: "Plugin: Verzeichnis existiert, ist aber keine gültige Installation (foreign) — {0}",
    hostNoApp: "Host-Patch: App nicht prüfbar ({0})",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "Plugin: nicht installiert — v{0} wird installiert",
    pluginPlanUpgrade: "Plugin: v{0} installiert — Upgrade auf v{1} möglich",
    pluginPlanLatest: "Plugin: bereits aktuell v{0} (byte-identisch)",
    pluginPlanRefused: "Das Plugin-Ziel erfordert manuelle Prüfung — {0}Der Assistent kann nicht fortfahren; Erzwingung über den Flag-Modus (--force im README).",
    allUpToDate: "Alles ist bereits aktuell — nichts zu tun.",
    completeNoop: "Fertig — alles war bereits aktuell; es wurden keine Änderungen vorgenommen.",
  },
  es: {
    title: 'Hermes Output Enhancement — instalador',
    currentStatus: 'Estado actual',
    pluginLabel: 'Plugin',
    hostLabel: 'Parche del host',
    askPlugin: '¿Instalar o actualizar el plugin de mejora de salida? (y/N)',
    askHost: '¿Aplicar el parche del host (sincronización en vivo del interruptor entre ventanas)?\nNota: sal de la app primero; el sello de firma queda roto hasta la reversión; una actualización de Hermes sobrescribe el parche. (y/N)',
    planTitle: 'Plan (vista previa sin escritura)',
    confirmProceed: '¿Ejecutar el plan anterior? (y/N)',
    proceeding: 'Ejecutando…',
    cancelled: "Cancelado — no se modificó ningún archivo de la app ni del plugin.",
    complete: 'Instalación completa verificada: plugin + parche del host.',
    pluginOnlyDone: 'Paso del plugin completado.',
    failed: 'Error — consulta el informe anterior.',
    manualNeeded: 'Se requiere acción manual — consulta el informe.',
    savedLanguage: 'Usando idioma guardado: {0}',
    invalidChoice: 'Elección no válida — inténtalo de nuevo.',
    unknownHostNote: 'Tu compilación de Hermes no es un objetivo de parche registrado; el paso del parche del host no está disponible (solo plugin).',
    wizardIntro: "Este asistente instala o actualiza el plugin de mejora de salida y, opcionalmente, aplica el parche del host. Los archivos de la app de Hermes y del plugin no se modifican antes de la confirmación final; dentro de este checkout solo se guardan la preferencia de idioma y los informes de diagnóstico.",
    pluginPresent: "Plugin: instalado — {0}",
    pluginAbsent: "Plugin: no instalado",
    hostPatched: "Parche del host: aplicado y verificado",
    hostUnpatched: "Parche del host: no aplicado (compilación compatible — parche disponible)",
    hostUnknown: "Parche del host: compilación desconocida (parche no disponible)",
    hostVerifiedNoChange: "El parche del host ya está verificado — no se necesitan cambios.",
    nothingSelected: "No se seleccionó nada — saliendo sin cambios.",
    planDiagnostic: "—— vista previa del plan (salida de diagnóstico de las herramientas, en inglés) ——",
    reportSaved: "Informe unificado guardado: {0}",
    prefSavedNote: "Preferencia de idioma guardada dentro de este checkout (no se modificaron archivos de la app ni del plugin).",
    appPathPrompt: "Ruta de Hermes.app [Intro = {0}]: ",
    pluginTargetPrompt: "Directorio destino del plugin [Intro = {0}]: ",
    applyNotes: "Antes de escribir — parche del host: primero se respalda el archivo original (.v2bak dentro de la app + copia autoritativa fuera de la app). El sello de firma de código de la app queda inválido hasta la reversión (la reversión restaura el archivo byte a byte y el sello — verificado). Una autoactualización futura de Hermes sobrescribirá el parche; vuelve a ejecutar este asistente después.",
    prefSaveFailed: "No se pudo guardar la preferencia de idioma ({0}); se continúa en este idioma por ahora.",
    pluginForeign: "Plugin: el directorio existe pero no es una instalación válida (foreign) — {0}",
    hostNoApp: "Parche del host: no se puede inspeccionar la app ({0})",
    // plan/short-circuit labels (shared adjudication from plugin-install --plan-json)
    pluginPlanInstall: "Complemento: no instalado — se instalará v{0}",
    pluginPlanUpgrade: "Complemento: instalado v{0} — se puede actualizar a v{1}",
    pluginPlanLatest: "Complemento: ya en la última versión v{0} (bytes idénticos)",
    pluginPlanRefused: "El destino del complemento requiere atención manual — {0}el asistente no puede continuar; forzado mediante el modo de flags (--force en el README).",
    allUpToDate: "Todo está ya actualizado — no hay nada que hacer.",
    completeNoop: "Hecho — todo estaba ya actualizado; no se realizaron cambios.",
  },
}

// Translate `key` for `locale`, falling back to English, then the key itself.
// `{0}`, `{1}`… interpolate from `params` (positional array).
export function t(locale, key, params = []) {
  const table = STRINGS[locale] ?? STRINGS.en
  let text = table[key] ?? STRINGS.en[key] ?? key
  params.forEach((value, index) => { text = text.replaceAll(`{${index}}`, String(value)) })
  return text
}

// Map a system locale hint (LANG / LC_ALL / Intl) onto a supported id.
export function detectLocale(env = process.env) {
  const hint = env.LC_ALL || env.LANG || (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : '') || ''
  const norm = hint.toLowerCase().replace('_', '-')
  if (norm.startsWith('zh')) return norm.includes('tw') || norm.includes('hk') || norm.includes('hant') ? 'zh-hant' : 'zh'
  if (norm.startsWith('ja')) return 'ja'
  if (norm.startsWith('ar')) return 'ar'
  if (norm.startsWith('ru')) return 'ru'
  if (norm.startsWith('fr')) return 'fr'
  if (norm.startsWith('de')) return 'de'
  if (norm.startsWith('es')) return 'es'
  return 'en'
}

// Remembered language lives inside the checkout (same policy as the other
// .local state): .local/setup-language.json
const PREF = path.join(root, '.local', 'setup-language.json')
export async function loadSavedLocale() {
  try { return JSON.parse(await readFile(PREF, 'utf8')).locale ?? null } catch { return null }
}
export async function saveLocale(locale) {
  if (!LOCALES.some(l => l.id === locale)) throw new Error(`unsupported locale: ${locale}`)
  await mkdir(path.dirname(PREF), { recursive: true })
  const tmp = PREF + '.tmp-' + process.pid
  await writeFile(tmp, JSON.stringify({ locale, at: new Date().toISOString() }, null, 2) + '\n')
  await rename(tmp, PREF) // staged + rename: a torn pref write is never read half-baked
}

// --- self-check -------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--check')) {
  const base = Object.keys(STRINGS.en).sort()
  let failed = false
  for (const { id } of LOCALES) {
    const keys = Object.keys(STRINGS[id] ?? {}).sort()
    const missing = base.filter(k => !keys.includes(k))
    const extra = keys.filter(k => !base.includes(k))
    if (missing.length || extra.length || keys.length !== base.length) {
      failed = true
      console.error(`[fail] ${id}: missing=${missing.join(',')} extra=${extra.join(',')}`)
    } else {
      console.log(`[ok] ${id}: ${keys.length} keys`)
    }
  }
  const stray = Object.keys(STRINGS).filter(id => !LOCALES.some(l => l.id === id))
  if (stray.length) { failed = true; console.error(`[fail] stray locale tables: ${stray.join(',')}`) }
  // every {n} placeholder must exist in every locale
  for (const { id } of LOCALES) {
    for (const key of base) {
      const enPh = [...STRINGS.en[key].matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',')
      const locPh = [...String(STRINGS[id][key]).matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',')
      if (enPh !== locPh) { failed = true; console.error(`[fail] ${id}.${key}: placeholders ${locPh} != en ${enPh}`) }
    }
  }
  console.log(failed ? 'PARITY-FAIL' : 'PARITY-OK (9 locales)')
  process.exit(failed ? 1 : 0)
}
