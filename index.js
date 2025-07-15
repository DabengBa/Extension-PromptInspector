import { eventSource, event_types, main_api, stopGeneration } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { t } from '../../../i18n.js';

const path = 'third-party/Extension-PromptInspector';

if (!('GENERATE_AFTER_COMBINE_PROMPTS' in event_types) || !('CHAT_COMPLETION_PROMPT_READY' in event_types)) {
    toastr.error('Required event types not found. Update SillyTavern to the latest version.');
    throw new Error('Events not found.');
}

function isChatCompletion() {
    return main_api === 'openai';
}

function addLaunchButton() {
    const enabledText = t`Stop Inspecting`;
    const disabledText = t`Inspect Prompts`;
    const enabledIcon = 'fa-solid fa-bug-slash';
    const disabledIcon = 'fa-solid fa-bug';

    const getIcon = () => inspectEnabled ? enabledIcon : disabledIcon;
    const getText = () => inspectEnabled ? enabledText : disabledText;

    const launchButton = document.createElement('div');
    launchButton.id = 'inspectNextPromptButton';
    launchButton.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    launchButton.tabIndex = 0;
    launchButton.title = t`Toggle prompt inspection`;
    const icon = document.createElement('i');
    icon.className = getIcon();
    launchButton.appendChild(icon);
    const textSpan = document.createElement('span');
    textSpan.textContent = getText();
    launchButton.appendChild(textSpan);

    const extensionsMenu = document.getElementById('prompt_inspector_wand_container') ?? document.getElementById('extensionsMenu');
    extensionsMenu.classList.add('interactable');
    extensionsMenu.tabIndex = 0;

    if (!extensionsMenu) {
        throw new Error('Could not find the extensions menu');
    }

    extensionsMenu.appendChild(launchButton);
    launchButton.addEventListener('click', () => {
        toggleInspectNext();
        textSpan.textContent = getText();
        icon.className = getIcon();
    });
}

let inspectEnabled = localStorage.getItem('promptInspectorEnabled') === 'true' || false;

function toggleInspectNext() {
    inspectEnabled = !inspectEnabled;
    toastr.info(`Prompt inspection is now ${inspectEnabled ? 'enabled' : 'disabled'}`);
    localStorage.setItem('promptInspectorEnabled', String(inspectEnabled));
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (data) => {
    if (!inspectEnabled) {
        return;
    }

    if (data.dryRun) {
        console.debug('Prompt Inspector: Skipping dry run prompt');
        return;
    }

    if (!isChatCompletion()) {
        console.debug('Prompt Inspector: Not a chat completion prompt');
        return;
    }

    // 第1步：转换为可读格式
    const readablePrompt = toReadableFormat(data.chat);
    const result = await showPromptInspector(readablePrompt);

    if (result === readablePrompt) { // 检查可读格式是否有变化
        console.debug('Prompt Inspector: No changes');
        return;
    }

    try {
        // 第2步：从可读格式转换回JSON数组对象
        const chat = fromReadableFormat(result);

        // Chat is passed by reference, so we can modify it directly
        if (Array.isArray(chat) && Array.isArray(data.chat)) {
            data.chat.splice(0, data.chat.length, ...chat);
        }

        console.debug('Prompt Inspector: Prompt updated');
    } catch (e) {
        console.error('Prompt Inspector: Invalid JSON or readable format', e);
        toastr.error('Invalid readable format: ' + e.message);
    }
});

eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, async (data) => {
    if (!inspectEnabled) {
        return;
    }

    if (data.dryRun) {
        console.debug('Prompt Inspector: Skipping dry run prompt');
        return;
    }

    if (isChatCompletion()) {
        console.debug('Prompt Inspector: Not a chat completion prompt');
        return;
    }

    const result = await showPromptInspector(data.prompt);

    if (result === data.prompt) {
        console.debug('Prompt Inspector: No changes');
        return;
    }

    data.prompt = result;
    console.debug('Prompt Inspector: Prompt updated');
});

/**
 * 将聊天JSON数组转换为可读的字符串格式
 * @param {Array<Object>} chatArray - The chat completion array
 * @returns {string} A human-readable string representation
 */
function toReadableFormat(chatArray) {
    if (!Array.isArray(chatArray)) return JSON.stringify(chatArray, null, 4); // 如果不是预期的格式,则返回原始JSON

    return chatArray.map(item => {
        // 每个消息块由 角色行、内容、分隔符 组成
        return `${item.role}:\n${item.content}\n--------------------`;
    }).join('\n');
}

/**
 * 将可读的字符串格式转换回聊天JSON数组
 * @param {string} readableString - The human-readable string
 * @returns {Array<Object>} The chat completion array
 */
function fromReadableFormat(readableString) {
    const chatArray = [];
    // 使用分隔符来切分每个消息块
    const blocks = readableString.trim().split(/^-{5,}\s*$/m);

    for (const block of blocks) {
        if (block.trim() === '') continue;

        // 匹配第一行的 "role:"
        const match = block.trim().match(/^(\w+):\s*\n/);
        if (match && match[1]) {
            const role = match[1];
            // role之后的所有内容都算作content
            const content = block.trim().substring(match[0].length).trim();
            chatArray.push({ role, content });
        } else {
            // 如果格式不匹配, 抛出错误, 防止发送错误的数据
            throw new Error('Invalid format in prompt. Each block must start with "role:".');
        }
    }

    return chatArray;
}

/**
 * Shows a prompt inspector popup.
 * @param {string} input Initial prompt JSON
 * @returns {Promise<string>} Updated prompt JSON
 */
async function showPromptInspector(input) {
    const template = $(await renderExtensionTemplateAsync(path, 'template'));
    const prompt = template.find('#inspectPrompt');
    prompt.val(input);
    /** @type {import('../../../popup').CustomPopupButton} */
    const customButton = {
        text: 'Cancel generation',
        result: POPUP_RESULT.CANCELLED,
        appendAtEnd: true,
        action: async () => {
            await stopGeneration();
            await popup.complete(POPUP_RESULT.CANCELLED);
        },
    };
    const popup = new Popup(template, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: 'Save changes', cancelButton: 'Discard changes', customButtons: [customButton] });
    const result = await popup.show();

    // If the user cancels, return the original input
    if (!result) {
        return input;
    }

    return String(prompt.val());
}

(function init() {
    addLaunchButton();
})();
