// Proposal card: the summary lines come from the server (generated from validated ops).

const BADGES = {
  stale: 'Stale', expired: 'Expired', applied: 'Applied', cancelled: 'Cancelled', replaced: 'Replaced',
};
const BANNERS = {
  stale: 'Design changed – ask the agent to re-propose.',
  expired: 'This proposal expired – ask the agent again.',
};

export function renderProposalCard(entry, chat) {
  const status = chat.statusOf(entry);
  const card = document.getElementById('proposal-card-template').content.firstElementChild.cloneNode(true);
  card.dataset.status = status;
  card.dataset.testid = 'proposal-card';

  const list = card.querySelector('.proposal-card__list');
  for (const line of entry.proposal.summary) {
    const item = document.createElement('li');
    item.textContent = line;
    list.append(item);
  }

  const badge = card.querySelector('.proposal-card__badge');
  if (BADGES[status]) {
    badge.textContent = BADGES[status];
    badge.hidden = false;
  }
  if (BANNERS[status]) {
    card.classList.add('proposal-card--stale');
    card.querySelector('.proposal-card__stale-text').textContent = BANNERS[status];
    card.querySelector('.proposal-card__stale').hidden = false;
  }
  if (['applied', 'cancelled', 'replaced'].includes(status)) card.classList.add('proposal-card--closed');

  const confirmButton = card.querySelector('[data-action="confirm"]');
  const cancelButton = card.querySelector('[data-action="cancel"]');
  confirmButton.disabled = status !== 'pending';
  cancelButton.disabled = !['pending', 'stale', 'expired'].includes(status);
  if (status === 'applying') confirmButton.lastChild.textContent = 'Applying…';
  confirmButton.addEventListener('click', () => chat.confirm(entry));
  cancelButton.addEventListener('click', () => chat.cancel(entry));
  return card;
}
