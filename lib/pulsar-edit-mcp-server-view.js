'use strict';

class PulsarMcpView {

  constructor(serializedState) {
    this.element = document.createElement('div');
    this.element.classList.add('pulsar-edit-mcp-server');
  }

  serialize() {}

  destroy() {
    this.element.remove();
  }

  getElement() {
    return this.element;
  }

}

module.exports = PulsarMcpView;
