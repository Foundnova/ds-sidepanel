// panel.js — 只负责显示 iframe 和加载状态
//
// 跨域 iframe 无法读取内容，所以只做最基本的事：
//   · load 事件 = 页面导航完成，隐藏加载指示器
//   · 15 秒内没 load = 提示重试

const frame    = document.getElementById('frame');
const loading  = document.getElementById('loading');
const errorBox = document.getElementById('error');
const errorMsg = document.getElementById('error-msg');

let loadTimer = null;

function hideLoading() {
  loading.classList.add('hide');
  setTimeout(() => { loading.style.display = 'none'; }, 300);
}

function showError(msg) {
  errorMsg.textContent = msg || '请检查网络连接后重试。';
  errorBox.classList.add('show');
  hideLoading();
}

function hideError() {
  errorBox.classList.remove('show');
}

function startTimer() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    showError('加载超时，请检查网络连接后重试。');
  }, 15000);
}

function reload() {
  hideError();
  loading.style.display = '';
  loading.classList.remove('hide');
  frame.src = 'https://chat.deepseek.com/?_t=' + Date.now();
  startTimer();
}

frame.addEventListener('load', () => {
  clearTimeout(loadTimer);
  hideLoading();
});

document.getElementById('retry').addEventListener('click', reload);

startTimer();
