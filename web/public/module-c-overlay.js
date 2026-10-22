import { installPaidBoard } from './module-c-board.js';
import { ensureAlertSurface } from './module-c-alerts.js';

const board = document.getElementById('mc-board');
installPaidBoard(board, { alertsElement: ensureAlertSurface(board) });
