import ComponentManager from 'sn-components-api';
import "standard-file-js/dist/regenerator.js";
import { StandardFile, SFAbstractCrypto, SFItemTransformer, SFHttpManager, SFItem } from 'standard-file-js';
import RelayManager from "./RelayManager";

const ComponentKeyCredentialsKey = "ComponentKeyCredentialsKey";
const ComponentKeyIntegrationsArrayKey = "ComponentKeyIntegrationsArrayKey";

var EncryptionWorker = require("worker-loader?name=hash.worker.js!./encryptionWorker");
var UploadWorker = require("worker-loader?name=hash.worker.js!./uploadWorker");

const DefaultHeight = 135;

export default class BridgeManager {
  static FileItemContentTypeKey = "SN|FileSafe|File";
  static FileItemMetadataContentTypeKey = "SN|FileSafe|FileMetadata";

  /* Singleton */
  static instance = null;
  static get() {
    if (this.instance == null) { this.instance = new BridgeManager(); }
    return this.instance;
  }

  constructor(onReceieveItems) {

    this.updateObservers = [];
    this.items = [];
    this.size = null;
  }

  addUpdateObserver(callback) {
    let observer = {id: Math.random, callback: callback};
    this.updateObservers.push(observer);
    return observer;
  }

  removeUpdateObserver(observer) {
    this.updateObservers.splice(this.updateObservers.indexOf(observer), 1);
  }

  initiateBridge(onReady) {
    this.componentManager = new ComponentManager([], () => {
      onReady && onReady();

      this.loadOrCreateCredentials().then((credentials) => {
        console.log("Loaded credentials", credentials);
        this.authParams = credentials.authParams;
        this.keys = credentials.keys;
      });
    });

    // this.componentManager.acceptsThemes = false;

    this.componentManager.setSize("content", "90%", "90%");
    this.componentManager.setSize("container", "100%", DefaultHeight);
  }

  toggleHeight() {
    if(this.expanded) {
      this.setHeightCollapsed();
    } else {
      this.setHeightExpanded();
    }
  }

  setHeightExpanded() {
    this.expanded = true;
    this.componentManager.setSize("container", "100%", 200);
  }

  setHeightCollapsed() {
    this.expanded = false;
    this.componentManager.setSize("container", "100%", DefaultHeight);
  }

  setHeight(height) {
  }

  setComponentData(key, value) {
    this.componentManager.setComponentDataValueForKey(key, value);
  }

  getComponentData(key) {
    return this.componentManager.componentDataValueForKey(key);
  }

  async loadOrCreateCredentials() {
    let credentials = this.getComponentData(ComponentKeyCredentialsKey);
    if(!credentials) {
      let bits = 256;
      let identifer = await SFJS.crypto.generateRandomKey(bits);
      let password = await SFJS.crypto.generateRandomKey(bits);
      let credentials = await SFJS.crypto.generateInitialKeysAndAuthParamsForUser(identifer, password);
      this.setComponentData(ComponentKeyCredentialsKey, credentials);
      return credentials;
    } else {
      return credentials;
    }
  }

  getItemAppDataValue(item, key) {
    return this.componentManager.getItemAppDataValue(item, key);
  }

  getSelfComponentUUID() {
    return this.componentManager.getSelfComponentUUID();
  }

  didBeginStreaming() {
    return this._didBeginStreaming;
  }

  async saveItems(items) {
    return new Promise((resolve, reject) => {
      this.componentManager.saveItems(items, (response) => {
        resolve(response);
      })
    })
  }

  getRawIntegrations() {
    return this.getComponentData(ComponentKeyIntegrationsArrayKey) || [];
  }

  getIntegrations() {
    var integrationStrings = this.getRawIntegrations();
    var integrations = [];

    for(var integrationBase64String of integrationStrings) {
      // console.log("Attempting to decode string", integrationBase64String);
      var jsonString = atob(integrationBase64String);
      var integration = JSON.parse(jsonString);
      integration.rawCode = integrationBase64String;
      integrations.push(integration);
    }
    return integrations;
  }

  integrationForFile(metadata) {
    return this.getIntegrations().find((integration) => {
      console.log("integrationForFile", integration, metadata);
      return metadata.content.serverMetadata && integration.source == metadata.content.serverMetadata.source;
    });
  }

  saveIntegration(code) {
    console.log("Saving integration", code);
    let integrations = this.getRawIntegrations();
    integrations.push(code);
    this.setComponentData(ComponentKeyIntegrationsArrayKey, integrations);
  }

  deleteIntegration(integrationObject) {
    let rawIntegrations = this.getRawIntegrations();
    _.pull(rawIntegrations, integrationObject.rawCode);
    this.setComponentData(ComponentKeyIntegrationsArrayKey, rawIntegrations);
    this.notifyObserversOfUpdate();
  }

  categorizedItems() {
    var types = {};
    for(var item of this.items) {
      var array = types[item.content_type];
      if(!array) {
        array = [];
        types[item.content_type] = array;
      }
      array.push(item);
    }
    return types;
  }

  beginStreamingItem() {
    this._didBeginStreaming = true;
    this.componentManager.streamContextItem((note) => {
      this.note = new SFItem(note);

      console.log("Received note", this.note);

       // Only update UI on non-metadata updates.
      if(this.note.isMetadataUpdate) {
        return;
      }

      this.notifyObserversOfUpdate();
    });

    this.componentManager.streamItems([BridgeManager.FileItemMetadataContentTypeKey], (items) => {
      for(var item of items) {
        item = new SFItem(item);

        if(item.deleted) {
          this.removeItemFromItems(item);
          continue;
        }
        if(item.isMetadataUpdate) {
          continue;
        }

        var index = this.indexOfItem(item);
        if(index >= 0) {
          this.items[index] = item;
        } else {
          this.items.push(item);
        }
      }

      this.notifyObserversOfUpdate();
    })
  }

  // Returns the metadata objects associated with the current note
  filesForCurrentNote() {
    return this.items.filter((metadataItem) => {
      return metadataItem.hasRelationshipWithItem(this.note);
    })
  }

  indexOfItem(item) {
    for(var index in this.items) {
      if(this.items[index].uuid == item.uuid) {
        return index;
      }
    }
    return -1;
  }

  removeItemFromItems(item) {
    this.items = this.items.filter((candidate) => {return candidate.uuid !== item.uuid});
  }

  createItems(items, callback) {
    for(var item of items) { item.uuid = null; }
    this.componentManager.createItems(items, (createdItems) => {
      callback(createdItems);
    })
  }

  indexOfItem(item) {
    for(var index in this.items) {
      if(this.items[index].uuid == item.uuid) {
        return index;
      }
    }
    return -1;
  }

  async deleteFile(metadataItem) {
    return new Promise((resolve, reject) => {
      this.componentManager.deleteItem(metadataItem, (response) => {
        if(response.deleted) {
          let integration = this.integrationForFile(metadataItem);
          RelayManager.get().deleteFile(metadataItem, integration).then((relayResponse) => {
            resolve();
          })
        } else {
          resolve(response);
        }
      });
    })
  }

  deleteItems(items) {
    this.componentManager.deleteItems(items);
  }

  removeItemFromItems(item) {
    this.items = this.items.filter((candidate) => {return candidate.uuid !== item.uuid});
  }

  notifyObserversOfUpdate() {
    for(var observer of this.updateObservers) {
      observer.callback();
    }
  }

  async uploadFile(itemParams, inputFileName, fileType) {
    var integration = BridgeManager.get().getIntegrations()[0];
    var outputFileName = `${inputFileName}.sf.json`;

    return new Promise((resolve, reject) => {
      const worker = new UploadWorker();

      worker.addEventListener("message", function (event) {
        console.log("Upload worker complete", event.data);
      });

      worker.postMessage({outputFileName, itemParams, integration});
    })

    return RelayManager.get().uploadFile(outputFileName, itemParams, integration).then((metadata) => {
      var metadataItem = new SFItem({
        content_type: BridgeManager.FileItemMetadataContentTypeKey,
        content: {
          serverMetadata: metadata,
          fileName: inputFileName,
          fileType: fileType
        }
      });

      metadataItem.addItemAsRelationship(this.note);
      this.saveItems([metadataItem]);
    }).catch((error) => {

    });
  }

  async downloadFile(metadataItem) {
    var integration = this.integrationForFile(metadataItem);
    // console.log("Using integration for download", integration);
    return RelayManager.get().downloadFile(metadataItem, integration).then((data) => {
      var item = data.items[0];
      return item;
    })
  }

  async encryptFile(data, inputFileName, fileType) {
    return new Promise((resolve, reject) => {
      const worker = new EncryptionWorker();

      worker.addEventListener("message", function (event) {
        // console.log("Encryption worker complete", event.data);
        resolve(event.data.itemParams);
      });

      worker.postMessage({
        operation: "encrypt",
        keys: BridgeManager.get().keys,
        authParams: BridgeManager.get().authParams,
        contentType: BridgeManager.FileItemContentTypeKey,
        fileData: data,
        fileName: inputFileName,
        fileType: fileType
      });
    })
  }

  async decryptFile(item) {
    return new Promise((resolve, reject) => {
      const worker = new EncryptionWorker();

      worker.addEventListener("message", function (event) {
        // console.log("Decryptkion worker complete", event.data);
        resolve(event.data.decryptedData);
      });

      worker.postMessage({
        operation: "decrypt",
        keys: BridgeManager.get().keys,
        item: item
      });
    })
  }

}
